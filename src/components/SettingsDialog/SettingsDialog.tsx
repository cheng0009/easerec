import { useCallback, useEffect, useState } from "react";
import { useStore } from "../../store";
import { tauriInvoke } from "../../lib/tauri";
import { refreshFallbackShortcuts } from "../../recording/startup";
import wechatQr from "../../assets/wechat_qr.jpg";
import { AUTHOR_STORY_ZH, AUTHOR_STORY_EN } from "../../lib/authorStory";
import alipayQr from "../../assets/alipay_qr.jpg";
import { useLang } from "../../lib/useLang";


interface ShortcutEntry { key: string; modifiers: string[]; }
type ShortcutConfig = Record<string, ShortcutEntry>;

const KEY_LABELS: Record<string, string> = {
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6", F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
  KeyA: "A", KeyB: "B", KeyC: "C", KeyD: "D", KeyE: "E", KeyF: "F", KeyG: "G", KeyH: "H", KeyI: "I", KeyJ: "J", KeyK: "K", KeyL: "L",
  KeyM: "M", KeyN: "N", KeyO: "O", KeyP: "P", KeyQ: "Q", KeyR: "R", KeyS: "S", KeyT: "T", KeyU: "U", KeyV: "V", KeyW: "W", KeyX: "X", KeyY: "Y", KeyZ: "Z",
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4", Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
  Tab: "Tab", Escape: "Esc", Space: "Space", Enter: "Enter",
};

function fmtEntry(e: ShortcutEntry): string {
  if (!e) return "?";
  const key = KEY_LABELS[e.key] ?? e.key;
  const mods = (e.modifiers ?? []).map((m) => (m === "CONTROL" || m === "CTRL" ? "Ctrl" : m === "ALT" ? "Alt" : m === "SHIFT" ? "Shift" : m)).join("+");
  return mods ? `${mods}+${key}` : key;
}

function KeyCapture({ value, onChange, label }: { value: ShortcutEntry; onChange: (e: ShortcutEntry) => void; label: string }) {
  const L = useLang();
  const [capturing, setCapturing] = useState(false);
  const handleKeyDown = useCallback((ev: KeyboardEvent) => {
    ev.preventDefault(); ev.stopPropagation();
    const code = ev.code;
    if (!code || ["MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight"].includes(code)) return;
    const mods: string[] = [];
    if (ev.ctrlKey) mods.push("CONTROL");
    if (ev.altKey) mods.push("ALT");
    if (ev.shiftKey) mods.push("SHIFT");
    onChange({ key: code, modifiers: mods });
    setCapturing(false);
  }, [onChange]);
  useEffect(() => {
    if (capturing) { window.addEventListener("keydown", handleKeyDown, true); return () => window.removeEventListener("keydown", handleKeyDown, true); }
  }, [capturing, handleKeyDown]);
  return (
    <div style={row}>
      <span style={rowLabel}>{label}</span>
      <button style={{ ...capBtn, background: capturing ? "var(--accent)" : "var(--bg-tertiary)", color: capturing ? "#fff" : "var(--text-primary)" }}
        onClick={() => setCapturing(true)}>{capturing ? L("按任意键…", "Press any key…") : fmtEntry(value)}</button>
    </div>
  );
}

/** ⚙ Settings dialog — shortcuts (collapsed groups) + real video/audio params + output. */
export function SettingsDialog() {
  const L = useLang();
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const audioSource = useStore((s) => s.recording.audioSource);
  const isRecording = useStore((s) => s.recording.isRecording);
  const [shortcuts, setShortcuts] = useState<ShortcutConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>("record");
  const [storyOpen, setStoryOpen] = useState(false);

  useEffect(() => {
    if (!ui.settingsOpen) return;
    void tauriInvoke<ShortcutConfig>("get_shortcut_config").then(setShortcuts).catch(() => {});
  }, [ui.settingsOpen]);

  if (!ui.settingsOpen) return null;

  const save = async () => {
    if (shortcuts) {
      await tauriInvoke("update_shortcut_config", { cfg: shortcuts });
      refreshFallbackShortcuts(shortcuts);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const setAs = async (src: "system" | "mic" | "both") => {
    useStore.getState().setRecording({ audioSource: src });
    await tauriInvoke("set_audio_source", { source: src });
  };

  const group = (id: string, title: string, entries: [string, string | undefined][], extra?: React.ReactNode) => (
    <div style={sec}>
      <button style={secHead} onClick={() => setOpenGroup(openGroup === id ? null : id)}>
        <span>{openGroup === id ? "▾" : "▸"} {title}</span>
        <span style={secMeta}>{entries.map(([, v]) => v ?? "?").join(" · ")}</span>
      </button>
      {openGroup === id && (
        <div style={{ marginTop: 6 }}>
          {entries.map(([cmd, label]) => (
            <KeyCapture key={cmd} label={label ?? cmd} value={shortcuts?.[cmd] ?? { key: "", modifiers: [] }}
              onChange={(e) => setShortcuts({ ...(shortcuts ?? {}), [cmd]: e })} />
          ))}
          {extra}
        </div>
      )}
    </div>
  );

  return (
    <div style={styles.mask} onClick={() => setUi({ settingsOpen: false })}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.head}>
          <span style={styles.title}>⚙ {L("设置", "Settings")}</span>
          <button style={styles.close} onClick={() => setUi({ settingsOpen: false })}>✕</button>
        </div>

        {group("record", L("录制控制", "Recording"), [
          ["toggle_recording", L("开始/停止录制", "Start/stop recording")],
          ["toggle_pause", L("暂停 / 恢复", "Pause / resume")],
        ])}
        {group("marks", L("导播标记", "Direction marks"), [
          ["toggle_ff", L("快进模式", "Fast-forward")],
          ["toggle_privacy", L("隐私遮挡", "Privacy mask")],
          ["toggle_privacy_cut", L("隐私整段剪除", "Privacy cut")],
        ], (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={hint2}>⏩ {L("快进模式：录制中的漫长等待（安装/加载/翻页）标记为快进段，导出时无论多长都压缩成 3-5 秒，并垫入轻快音效。", "Fast-forward: mark boring waits (installs/loading) — they compress to 3-5s with a whoosh at export.")}</div>
            <div style={hint2}>🛡 {L("隐私遮挡：屏幕局部出现敏感信息（密钥/账号）时框选遮挡，出现马赛克块并自动回溯到内容首次出现处。", "Privacy mask: box sensitive regions (keys/accounts) — a mosaic block appears and auto-backtraces to its first appearance.")}</div>
            <div style={hint2}>🔒 {L("隐私整段剪除：整屏私密操作（登录/输密码）成对标记起点终点，导出时整段剪掉。", "Privacy cut: mark whole private spans (logins/passwords) in pairs — removed entirely at export.")}</div>
          </div>
        ))}
        {group("effects", L("导播特效", "Effects"), [
          ["toggle_magnifier", L("放大镜", "Magnifier")],
          ["toggle_step_marker", L("步骤序号", "Step markers")],
          ["toggle_highlighter", L("荧光笔", "Highlighter")],
          ["toggle_ripple", L("点击涟漪", "Click ripple")],
        ])}
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{L("提示：被其他软件占用的键会自动以底层轮询兜底", "Keys grabbed by other apps fall back to low-level polling automatically")}</span>
          <button style={saveBtn} onClick={save}>{saved ? L("✓ 已保存", "✓ Saved") : L("保存快捷键", "Save shortcuts")}</button>
        </div>

        <div style={sec}>
          <div style={secHead2}>{L("视频", "Video")}</div>
          <div style={row}>
            <span style={rowLabel}>{L("帧率", "Frame rate")}</span>
            <select style={sel} value={settings.fps} onChange={(e) => setSettings({ fps: +e.target.value })}>
              {[30, 60, 120].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div style={row}>
            <span style={rowLabel}>{L("分辨率", "Resolution")}</span>
            <select style={sel} value={`${settings.resolution.width}x${settings.resolution.height}`}
              onChange={(e) => { const [w, h] = e.target.value.split("x").map(Number); setSettings({ resolution: { width: w, height: h } }); }}>
              <option value="1920x1080">1080p</option>
              <option value="2560x1440">1440p</option>
              <option value="3840x2160">4K</option>
            </select>
          </div>
          <div style={row}>
            <span style={rowLabel}>{L("码率", "Bitrate")}</span>
            <select style={sel} value={settings.bitrateMbps} onChange={(e) => setSettings({ bitrateMbps: +e.target.value })}>
              {[10, 20, 40, 80].map((b) => <option key={b} value={b}>{b} Mbps</option>)}
            </select>
          </div>
          <div style={row}>
            <div style={{ flex: 1 }}>
              <div style={rowLabel}>{L("智能跟焦", "Smart follow zoom")}</div>
              <div style={hint2}>{L("录制时仅记录鼠标轨迹（零性能负担），导出时按轨迹平滑渲染镜头跟随与放大。", "Logs the cursor path while recording (zero overhead); the follow/zoom motion is rendered smoothly at export.")}</div>
            </div>
            <input type="checkbox" checked={settings.zoomEnabled} onChange={(e) => setSettings({ zoomEnabled: e.target.checked })} />
          </div>
          {settings.zoomEnabled && (
            <div style={row}>
              <span style={rowLabel}>{L("放大倍率", "Zoom level")}</span>
              <select style={sel} value={settings.zoomLevel} onChange={(e) => setSettings({ zoomLevel: +e.target.value })}>
                {[1.2, 1.5, 2].map((z) => <option key={z} value={z}>{z}×</option>)}
              </select>
            </div>
          )}
          <div style={hint2}>{L("下次开始录制时生效；输出为 WebM (VP9)，导出时转 MP4。", "Applied at the next recording; output is WebM (VP9), converted to MP4 on export.")}</div>
        </div>

        <div style={sec}>
          <div style={secHead2}>{L("音频", "Audio")}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            {(["system", "mic", "both"] as const).map((s) => (
              <button key={s} style={{ ...ab, background: audioSource === s ? "var(--accent)" : "var(--bg-tertiary)", color: audioSource === s ? "#fff" : "var(--text-secondary)" }}
                disabled={isRecording} onClick={() => setAs(s)}>
                {s === "system" ? L("🔊 系统声音", "🔊 System") : s === "mic" ? L("🎤 麦克风", "🎤 Mic") : L("🔊🎤 全部", "🔊🎤 Both")}
              </button>
            ))}
          </div>
          {isRecording && <div style={hint2}>{L("录制中不可切换音源", "Audio source is locked while recording")}</div>}
        </div>

        <div style={sec}>
          <div style={secHead2}>{L("导出", "Export")}</div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
            <div style={{ flex: 1 }}>
              <div style={rowLabel}>{L("导出成功提示音", "Success chime on export")}</div>
              <div style={hint2}>{L("导出完成时播放内置提示音（可在导出前取消勾选）", "Plays the bundled chime when the film is exported")}</div>
            </div>
            <input type="checkbox" checked={settings.successSound !== false}
              onChange={(e) => setSettings({ successSound: e.target.checked })} />
          </div>
        </div>

        <div style={sec}>
          <button
            style={{ ...secHead, color: "var(--accent)", fontWeight: 700 }}
            onClick={() => setStoryOpen(!storyOpen)}
          >
            <span style={{ fontSize: 15 }}>{storyOpen ? "▾" : "▸"} 👨‍💻 {L("关于作者", "About the author")}</span>
            <span style={{ ...secMeta, color: "var(--accent)", opacity: 0.75 }}>{L("简录是怎么来的 ❤", "How EaseRec came to be ❤")}</span>
          </button>
          {!storyOpen && (
            <div style={{ fontSize: 10, color: "var(--accent)", opacity: 0.7, marginTop: 2 }}>
              {L("一位70后奶爸的手作软件…点开看看", "A handcrafted app by a 70s-born dad…")}
            </div>
          )}
          {storyOpen && (
            <div style={styles.story}>
              {(useStore.getState().current === "en" ? AUTHOR_STORY_EN : AUTHOR_STORY_ZH)
                .split("\n\n").map((para, i) => (
                  <p key={i} style={{ marginTop: i === 0 ? 0 : 8 }}>{para}</p>
                ))}
            </div>
          )}
        </div>

        <div style={sec}>
          <div style={secHead2}>{L("关于与赞助", "About & support")}</div>
          <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.6 }}>
            <p>{L("简录 EaseRec v0.2 — 让知识输出回归纯粹", "EaseRec v0.2 — recording, simplified")}</p>
            <p style={{ marginTop: 4 }}>{L("内置 FFmpeg (LGPL 2.1+) 用于导出。字幕需 whisper-cli（scripts/download-whisper.ps1）。", "Bundles FFmpeg (LGPL 2.1+) for export. Subtitles need whisper-cli (scripts/download-whisper.ps1).")}</p>
            <p style={{ marginTop: 6 }}>© 2026 {L("简录 EaseRec · 保留所有权利", "EaseRec · All rights reserved")}</p>
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", marginBottom: 6 }}>
              {L("☕ 支持简录（扫一扫赞助）", "☕ Support EaseRec")}
            </div>
            <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
              <DonateQR img={wechatQr} label={L("微信收款", "WeChat Pay")} />
              <DonateQR img={alipayQr} label={L("支付宝收款", "Alipay")} />
            </div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 8 }}>
              {L("功能建议或业务合作：V zhierIP", "Feedback & business: WeChat zhierIP")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DonateQR({ img, label }: { img: string; label: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) {
    return (
      <div style={{ width: 108, textAlign: "center" }} title={label}>
        <div style={donatePlaceholder}>＋</div>
        <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>{label}</div>
      </div>
    );
  }
  return (
    <div style={{ width: 108, textAlign: "center" }}>
      <img src={img} style={donateImg} alt={label} onError={() => setOk(false)} />
      <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

const row: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 7, gap: 8 };
const rowLabel: React.CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };
const capBtn: React.CSSProperties = { padding: "4px 12px", borderRadius: 4, border: "1px solid var(--border-default)", fontSize: 11, fontFamily: "var(--font-mono)", cursor: "pointer", minWidth: 110, textAlign: "center" };
const sec: React.CSSProperties = { marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-subtle)" };
const secHead: React.CSSProperties = {
  width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
  background: "none", border: "none", cursor: "pointer", padding: "4px 0",
  fontSize: 13, fontWeight: 700, color: "var(--text-primary)",
};
const secMeta: React.CSSProperties = { fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontWeight: 400 };
const secHead2: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: "var(--text-primary)", padding: "4px 0" };
const saveBtn: React.CSSProperties = {
  padding: "6px 16px", borderRadius: "var(--radius-sm)", background: "var(--accent)",
  color: "#fff", fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer",
};
const sel: React.CSSProperties = { width: 150, padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border-default)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 12 };
const ab: React.CSSProperties = { flex: 1, padding: "6px 6px", borderRadius: "var(--radius-sm)", fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer" };
const hint2: React.CSSProperties = { fontSize: 10, color: "var(--text-muted)", marginTop: 6 };
const donateImg: React.CSSProperties = { width: 108, height: 108, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border-default)", display: "block" };
const donatePlaceholder: React.CSSProperties = { width: 108, height: 108, borderRadius: 8, border: "1px dashed var(--border-default)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, color: "var(--text-muted)" };

const styles: Record<string, React.CSSProperties> = {
  mask: {
    position: "fixed", inset: 0, zIndex: 90, background: "var(--mask-bg)",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  panel: {
    width: 480, maxHeight: "82%", overflowY: "auto", background: "var(--bg-secondary)",
    border: "1px solid var(--border-default)", borderRadius: "var(--radius-lg)", padding: 16,
  },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  title: { fontSize: 15, fontWeight: 700, color: "var(--text-primary)" },
  close: { background: "none", border: "none", color: "var(--text-muted)", fontSize: 14, cursor: "pointer" },
  sec: { marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-subtle)" },
  secHead: {
    width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
    background: "none", border: "none", cursor: "pointer", padding: "4px 0",
    fontSize: 13, fontWeight: 700, color: "var(--text-primary)",
  },
  secHead2: { fontSize: 13, fontWeight: 700, color: "var(--text-primary)", padding: "4px 0" },
  secMeta: { fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontWeight: 400 },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 7, gap: 8 },
  rowLabel: { fontSize: 12, color: "var(--text-secondary)" },
  capBtn: { padding: "4px 12px", borderRadius: 4, border: "1px solid var(--border-default)", fontSize: 11, fontFamily: "var(--font-mono)", cursor: "pointer", minWidth: 110, textAlign: "center" },
  saveBtn: {
    padding: "6px 16px", borderRadius: "var(--radius-sm)", background: "var(--accent)",
    color: "#fff", fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer",
  },
  sel: { width: 150, padding: "3px 6px", borderRadius: 4, border: "1px solid var(--border-default)", background: "var(--bg-primary)", color: "var(--text-primary)", fontSize: 12 },
  ab: { flex: 1, padding: "6px 6px", borderRadius: "var(--radius-sm)", fontSize: 11, fontWeight: 600, border: "none", cursor: "pointer" },
  hint2: { fontSize: 10, color: "var(--text-muted)", marginTop: 6 },
};
