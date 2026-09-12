import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import { tauriInvoke } from "../../lib/tauri";
import { open } from "@tauri-apps/plugin-dialog";
import { useTauriEvent } from "../../hooks/useTauriEvent";
import { useLang, isZhLang } from "../../lib/useLang";
import successSoundUrl from "../../assets/successsound.WAV";

/** Right-side export drawer — everything between "素材" and "可发布的成片". */
export function ExportDrawer() {
  const L = useLang();
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const marks = useStore((s) => s.marks);
  const setMarks = useStore((s) => s.setMarks);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [chapters, setChapters] = useState<string | null>(null);
  const [whisperOk, setWhisperOk] = useState<boolean | null>(null);
  const [sysFonts, setSysFonts] = useState<string[]>([]);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    void tauriInvoke<string[]>("list_system_fonts").then(setSysFonts).catch(() => {});
  }, []);

  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void tauriInvoke("save_app_settings", { settings }).catch(() => {});
      try { localStorage.setItem("dc_app_settings_v3", JSON.stringify(settings)); } catch {}
    }, 600);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [settings]);

  useEffect(() => {
    void tauriInvoke<boolean>("check_whisper").then((ok) => setWhisperOk(!!ok)).catch(() => setWhisperOk(false));
  }, []);

  useTauriEvent<{ label: string; index: number; total: number }>("dc-export-progress", (p) => {
    setProgress(`[${p.index}/${p.total}] ${p.label}`);
  });

  if (!ui.exportOpen) return null;

  const style = settings.subtitleStyle;
  const updateStyle = (patch: Partial<typeof style>) => setSettings({ subtitleStyle: { ...style, ...patch } });
  const updateLlm = (patch: Partial<typeof settings.llm>) => setSettings({ llm: { ...settings.llm, ...patch } });

  const pickOutputDir = async () => {
    const selected = await open({ directory: true, multiple: false, title: "选择输出文件夹" });
    if (selected && typeof selected === "string") setSettings({ outputDir: selected });
  };

  const handleExport = async () => {
    setExporting(true); setResult(null); setProgress(null); setChapters(null);
    try {
      let savedPath = await tauriInvoke<string>("save_recording");
      if (!savedPath) {
        try { savedPath = localStorage.getItem("dc_last_save") || ""; } catch {}
      }
      if (!savedPath) { setResult(L("还没有可导出的录像 — 先录制一段。", "Nothing to export yet — record something first.")); return; }

      const outDir = (settings.outputDir || "").trim();
      const base = outDir ? outDir.replace(/[\\/]+$/, "") : "%USERPROFILE%/Desktop";
      const outputPath = base + "/DirectorCam_Recording.mp4";

      const msg = await tauriInvoke<string>("export_video", {
        inputPath: savedPath,
        outputPath,
        config: {
          fps: settings.fps,
          zoom_enabled: settings.zoomEnabled,
          zoom_level: settings.zoomLevel ?? 1.5,
          brand_outro: settings.brandOutro,
          brand_lang: useStore.getState().current === "en" ? "en" : "zh",
          trim_silence: settings.silenceThresholdS > 0,
          silence_threshold_s: settings.silenceThresholdS,
          loudnorm: settings.loudnorm,
          burn_subtitles: settings.subtitleEnabled,
          subtitle_style: settings.subtitleStyle,
          llm: settings.llm,
          glossary: settings.glossary,
          asrLanguage: settings.asrLanguage,
          modelPath: settings.modelPath,
          vertical_export: settings.verticalExport,
          source_width: settings.resolution.width,
          source_height: settings.resolution.height,
          intro_enabled: !!settings.introPath,
          intro_path: settings.introPath,
          intro_duration_s: settings.introDurationS,
          outro_enabled: !!settings.outroPath,
          outro_path: settings.outroPath,
          outro_duration_s: settings.outroDurationS,
        },
      });
      setResult(msg);
      if (msg.startsWith("Saved to:") && settings.successSound !== false) {
        try {
          const chime = new Audio(successSoundUrl);
          chime.volume = 1;
          void chime.play().catch(() => {});
        } catch { /* 提示音播放失败不影响导出 */ }
      }
    } catch (e) { setResult("Error: " + String(e)); }
    finally { setExporting(false); setProgress(null); }
  };

  const dismissRecovery = async (p: string) => {
    try { await tauriInvoke("recording_mark_finalized", { webmPath: p }); } catch { /* ignore */ }
    setMarks({ recoverable: marks.recoverable.filter((r) => r.webmPath !== p) });
  };

  const openContainingFolder = () => {
    const match = result?.match(/Saved to: (.+)/);
    if (match) tauriInvoke("open_folder", { path: match[1].replace(/（.*$/, "").replace(/[\\/][^\\/]+$/, "") }).catch(() => {});
  };

  const generateChapters = async () => {
    const match = result?.match(/Saved to: (.+?)(?:（|$)/);
    if (!match) return;
    setChapters(L("生成中…", "Generating…"));
    try {
      const meta = await tauriInvoke<{ title: string; description: string; tags: string[]; chapters: { timeMs: number; title: string }[]; markdownPath: string } | null>("generate_chapters", {
        transcriptPath: `${match[1].trim()}.transcript.json`,
        llm: settings.llm,
        glossary: settings.glossary,
      });
      if (!meta) { setChapters(L("生成失败：需要已完成的字幕导出 + 已启用的 LLM 校正。", "Failed: needs a subtitle export + LLM correction enabled.")); return; }
      const fmt = (ms: number) => {
        const s = Math.floor(ms / 1000);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      };
      setChapters([
        `${L("标题", "Title")}：${meta.title}`, "", `${L("简介", "Description")}：${meta.description}`, "",
        `${L("标签", "Tags")}：${meta.tags.join(" / ")}`, "", `${L("章节", "Chapters")}：`,
        ...meta.chapters.map((c) => `${fmt(c.timeMs)} ${c.title}`),
        "", `${L("已保存", "Saved")}: ${meta.markdownPath}`,
      ].join("\n"));
    } catch (e) { setChapters(L("生成失败", "Failed") + ": " + String(e)); }
  };

  return (
    <div style={styles.drawer}>
      <div style={styles.head}>
        <span style={styles.title}>📦 {L("导出成片", "Export film")}</span>
        <button style={styles.close} onClick={() => setUi({ exportOpen: false })}>✕</button>
      </div>
      <div style={styles.scroll}>

      {marks.recoverable.length > 0 && (
        <div style={styles.recovery}>
          <div style={{ fontSize: 11, fontWeight: 700 }}>⚠ {L("上次录制未正常结束", "Previous recording ended unexpectedly")}</div>
          {marks.recoverable.map((r) => (
            <div key={r.webmPath} style={styles.recoveryRow}>
              <span style={{ fontSize: 10, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.webmPath}>
                {r.webmPath.split(/[\\/]/).pop()} ({(r.sizeBytes / 1024 / 1024).toFixed(0)} MB)
              </span>
              <button style={styles.miniBtn} onClick={() => tauriInvoke("open_folder", { path: r.webmPath.replace(/[\\/][^\\/]+$/, "") })}>{L("打开", "Open")}</button>
              <button style={styles.miniBtn} onClick={() => void dismissRecovery(r.webmPath)}>{L("忽略", "Dismiss")}</button>
            </div>
          ))}
        </div>
      )}

      <Group label={L("画面与音频", "Picture & audio")}>
        <Toggle label={L("静音裁剪", "Silence trim")} hint={L("剪掉长静音，节奏更快", "Cuts long silences for tighter pacing")} value={settings.silenceThresholdS > 0}
          onChange={(v) => setSettings({ silenceThresholdS: v ? 1.5 : 0 })} />
        <Toggle label={L("响度归一", "Loudness normalize")} hint={L("EBU R128，成片音量一致", "EBU R128 — consistent loudness")} value={settings.loudnorm}
          onChange={(v) => setSettings({ loudnorm: v })} />
        <Toggle label={L("同时导出竖版 9:16", "Also export vertical 9:16")} hint={L("按录制时的镜头轨迹自动取景（抖音/Shorts）", "Auto-reframed from the camera track (Douyin/Shorts)")} value={settings.verticalExport}
          onChange={(v) => setSettings({ verticalExport: v })} />
        {/* Brand outro is fixed ON (it supports the project); not user-editable. */}
        <div style={rowStyle}>
          <div style={{ flex: 1 }}>
            <div style={labelStyle}>{L("附加品牌片尾", "Append brand outro")}</div>
            <div style={hintStyle}>{L("成片结尾附加 2.8 秒「简录 EaseRec」品牌动画（含品牌 Logo），感谢支持 ❤", "A 2.8s EaseRec brand card closes the film — logo, title & slogan, thank you ❤")}</div>
          </div>
          <input type="checkbox" checked readOnly disabled title={L("固定开启", "Always on")} />
        </div>
      </Group>

      <Group label={L("字幕", "Subtitles")}>
        <Toggle label={L("烧录字幕", "Burn subtitles")} hint={L("本地 whisper 识别 + 可选 LLM 校正", "Local whisper ASR + optional LLM correction")} value={settings.subtitleEnabled}
          onChange={(v) => setSettings({ subtitleEnabled: v })} />
        {settings.subtitleEnabled && (
          <div style={styles.subBlock}>
            {whisperOk === false && <div style={styles.warn}>{isZhLang() ? "⚠ 未找到 whisper-cli — 运行 scripts/download-whisper.ps1" : "⚠ whisper-cli not found — run scripts/download-whisper.ps1"}</div>}
            <Row label={L("识别语言", "ASR language")}>
              <select value={settings.asrLanguage} style={inp} onChange={(e) => setSettings({ asrLanguage: e.target.value })}>
                <option value="zh">中文</option>
                <option value="en">English</option>
                <option value="auto">Auto</option>
              </select>
            </Row>
            <Row label={L("字体", "Font")}>
              <select value={style.fontFamily || ""} style={{ ...inp, flex: 1, fontFamily: "var(--font-sans)" }}
                onChange={(e) => updateStyle({ fontFamily: e.target.value })}>
                {style.fontFamily && !sysFonts.includes(style.fontFamily) && (
                  <option value={style.fontFamily}>{style.fontFamily}（自定义）</option>
                )}
                {sysFonts.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </Row>
            <Row label={L("字号 / 边距", "Size / margin")}>
              <input type="number" min={12} max={96} value={style.fontSize} style={{ ...inp, width: 54 }}
                onChange={(e) => updateStyle({ fontSize: Number(e.target.value) || 28 })} />
              <input type="number" min={0} max={400} value={style.marginV} style={{ ...inp, width: 54 }}
                onChange={(e) => updateStyle({ marginV: Number(e.target.value) || 0 })} />
            </Row>
            <Row label={L("颜色 / 描边", "Fill / outline")}>
              <input type="color" value={style.color} style={colorInp}
                onChange={(e) => updateStyle({ color: e.target.value })} />
              <input type="color" value={style.outlineColor} style={colorInp}
                onChange={(e) => updateStyle({ outlineColor: e.target.value })} />
              <input type="number" min={0} max={10} value={style.outlineWidth} style={{ ...inp, width: 44 }}
                onChange={(e) => updateStyle({ outlineWidth: Number(e.target.value) || 0 })} />
            </Row>
            <Row label={L("位置", "Position")}>
              <select value={style.position} style={inp} onChange={(e) => updateStyle({ position: e.target.value as typeof style.position })}>
                <option value="bottom">{L("底部", "Bottom")}</option>
                <option value="middle">{L("居中", "Middle")}</option>
                <option value="top">{L("顶部", "Top")}</option>
              </select>
            </Row>
            {/* Live subtitle preview: renders with the EXACT configured style. */}
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{L("实时预览", "Live preview")}</span>
              <div style={{
                position: "relative", height: 96, marginTop: 4, borderRadius: 6,
                background: "linear-gradient(135deg,#7a4f35 0%,#c49a72 45%,#eed9ab 100%)",
                border: "1px solid var(--border-default)", overflow: "hidden",
              }}>
                <span
                  style={{
                    position: "absolute",
                    left: "50%",
                    transform: "translateX(-50%)",
                    ...(style.position === "top"
                      ? { top: style.marginV / 2 }
                      : style.position === "middle"
                        ? { top: "50%", transform: "translate(-50%,-50%)" }
                        : { bottom: style.marginV / 2 }),
                    fontFamily: `${style.fontFamily}, "Microsoft YaHei", sans-serif`,
                    fontSize: Math.max(9, Math.min(22, style.fontSize / 2)),
                    color: style.color,
                    WebkitTextStroke: `${Math.min(2, style.outlineWidth / 2)}px ${style.outlineColor}`,
                    paintOrder: "stroke fill",
                    whiteSpace: "nowrap",
                  }}
                >
                  字幕预览 Subtitle Preview
                </span>
              </div>
            </div>
            <div style={{ ...rowStyle, flexDirection: "column", alignItems: "stretch", gap: 4 }}>
              <span style={labelStyle}>{L("热词表（每行一个，注入识别与校正）", "Hot words (one per line, injected into ASR & correction)")}</span>
              <textarea value={settings.glossary} rows={2} style={styles.glossary}
                placeholder={"DeepSeek\nSpringCamera"}
                onChange={(e) => setSettings({ glossary: e.target.value })} />
            </div>
            <Toggle label={L("LLM 在线校正", "LLM online correction")} hint={L("改错字与同音字；时间戳不受影响，失败自动回退本地结果", "Fixes typos/homophones; timestamps untouched; falls back on failure")}
              value={settings.llm.enabled} onChange={(v) => updateLlm({ enabled: v })} />
            {settings.llm.enabled && (
              <div style={styles.subBlock}>
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>
                  {L("需填写你自己的 API Key（默认适配 DeepSeek，兼容 OpenAI 格式接口：智谱/通义/Kimi 等）", "Fill in YOUR OWN API key (defaults fit DeepSeek; any OpenAI-compatible endpoint works)")}
                </div>
                <Row label={L("接口地址", "Base URL")}>
                  <input type="text" value={settings.llm.baseUrl} style={{ ...inp, flex: 1 }}
                    onChange={(e) => updateLlm({ baseUrl: e.target.value })} />
                </Row>
                <Row label="API Key">
                  <input type="password" placeholder="sk-…（必填）" value={settings.llm.apiKey} style={{ ...inp, flex: 1 }}
                    onChange={(e) => updateLlm({ apiKey: e.target.value })} />
                </Row>
                <Row label={L("模型", "Model")}>
                  <input type="text" value={settings.llm.model} style={{ ...inp, flex: 1 }}
                    onChange={(e) => updateLlm({ model: e.target.value })} />
                </Row>
              </div>
            )}
          </div>
        )}
      </Group>

      <Group label={L("输出", "Output")}>
        <Row label={L("目录", "Folder")}>
          <div style={{ display: "flex", gap: 4, flex: 1 }}>
            <input type="text" value={settings.outputDir} placeholder={L("默认：桌面", "Default: Desktop")}
              style={{ ...inp, flex: 1 }} onChange={(e) => setSettings({ outputDir: e.target.value })} />
            <button style={styles.miniBtn} onClick={pickOutputDir}>📁</button>
          </div>
        </Row>
      </Group>

      </div>
      <div style={styles.actionDock}>
      <button style={{ ...btn, opacity: exporting ? 0.6 : 1 }}
        onClick={handleExport} disabled={exporting}>
        {exporting ? L("导出中…", "Exporting…") : L("🎬 开始导出", "🎬 Start export")}
      </button>
      {progress && <div style={styles.progress}>{progress}</div>}
      {result && (
        <div style={styles.result}>
          <span style={{ fontSize: 12, color: "var(--accent)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{result}</span>
          {result.startsWith("Saved to:") && (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button style={styles.miniBtn} onClick={openContainingFolder}>{L("📂 打开文件夹", "📂 Open folder")}</button>
              {settings.llm.enabled && (
                <button style={styles.miniBtn} onClick={generateChapters}>{L("✨ 生成章节与文案", "✨ Chapters & copy")}</button>
              )}
            </div>
          )}
        </div>
      )}
      {chapters && (
        <div style={styles.result}>
          <span style={{ fontSize: 11, color: "var(--text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{chapters}</span>
          {!chapters.startsWith("生成失败") && !chapters.startsWith("生成中") && (
            <button style={{ ...styles.miniBtn, marginTop: 8 }} onClick={() => navigator.clipboard.writeText(chapters).catch(() => {})}>{L("📋 复制", "📋 Copy")}</button>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid var(--border-subtle)" }}>
      <div style={groupTitle}>{label}</div>
      {children}
    </div>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={rowStyle}>
      <div style={{ flex: 1 }}>
        <div style={labelStyle}>{label}</div>
        {hint && <div style={hintStyle}>{hint}</div>}
      </div>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      {children}
    </div>
  );
}

const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8 };
const groupTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "var(--text-primary)" };
const labelStyle: React.CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };
const hintStyle: React.CSSProperties = { fontSize: 10, color: "var(--text-muted)", marginTop: 2, lineHeight: 1.5 };
const inp: React.CSSProperties = { padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border-default)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 12, fontFamily: "var(--font-mono)" };
const colorInp: React.CSSProperties = { width: 28, height: 22, padding: 0, border: "1px solid var(--border-default)", background: "none", cursor: "pointer" };
const btn: React.CSSProperties = { width: "100%", padding: "11px", borderRadius: "var(--radius-sm)", background: "var(--accent)", color: "#fff", fontSize: 14, fontWeight: 700, border: "none", cursor: "pointer" };

const styles: Record<string, React.CSSProperties> = {
  drawer: {
    position: "fixed", top: 40, right: 0, bottom: 40, width: 372, zIndex: 60,
    background: "var(--bg-secondary)", borderLeft: "1px solid var(--border-default)",
    padding: 14, paddingBottom: 0, display: "flex", flexDirection: "column",
    animation: "slideIn 0.18s ease-out", boxShadow: "-12px 0 32px rgba(0,0,0,0.45)",
  },
  scroll: { flex: 1, overflowY: "auto", minHeight: 0, paddingRight: 2 },
  actionDock: {
    position: "sticky", bottom: 0, margin: "0 -14px", padding: "10px 14px 12px",
    background: "var(--bg-secondary)", borderTop: "1px solid var(--border-default)",
  },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  title: { fontSize: 15, fontWeight: 700, color: "var(--text-primary)" },
  close: { background: "none", border: "none", color: "var(--text-muted)", fontSize: 14, cursor: "pointer" },
  subBlock: { margin: "6px 0 4px", padding: "8px 10px", background: "var(--bg-primary)", borderRadius: 6, border: "1px solid var(--border-subtle)" },
  glossary: { width: "100%", padding: "4px 6px", borderRadius: 4, border: "1px solid var(--border-default)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 11, fontFamily: "var(--font-mono)", resize: "vertical" },
  warn: { fontSize: 10, color: "#e8b64a", marginBottom: 4 },
  recovery: { marginBottom: 8, padding: 8, borderRadius: 6, background: "rgba(232,182,74,0.08)", border: "1px solid rgba(232,182,74,0.4)", display: "flex", flexDirection: "column", gap: 4 },
  recoveryRow: { display: "flex", alignItems: "center", gap: 6 },
  miniBtn: { fontSize: 11, padding: "3px 10px", borderRadius: 4, border: "1px solid var(--border-default)", background: "var(--bg-tertiary)", color: "var(--text-primary)", cursor: "pointer" },
  progress: { marginTop: 8, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" },
  result: { marginTop: 10, padding: 10, borderRadius: "var(--radius-sm)", background: "var(--bg-primary)" },
};
