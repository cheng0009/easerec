import { useRef } from "react";
import { useStore } from "../../store";
import { sectionHeader, card } from "../../styles/components/panel";
import { useLang } from "../../lib/useLang";
import { toggleTeleprompter, splitParagraphs, normalizeScriptText } from "../../recording/teleprompter";

export function TeleprompterPanel() {
  const L = useLang();
  const tp = useStore((s) => s.settings.teleprompter);
  const setSettings = useStore((s) => s.setSettings);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const update = (partial: Partial<typeof tp>) => {
    setSettings({ teleprompter: { ...tp, ...partial } });
  };

  const importTxt = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = normalizeScriptText(String(reader.result ?? ""));
      setSettings({ teleprompter: { ...useStore.getState().settings.teleprompter, text } });
    };
    reader.readAsText(f);
  };

  const paras = splitParagraphs(tp.text);

  return (
    <div style={card}>
      <h3 style={sectionHeader}>{L("📜 提词器", "📜 Teleprompter")}</h3>
      <button
        style={{ ...toggleBtn, background: tp.visible ? "var(--accent)" : "var(--bg-tertiary)", color: tp.visible ? "#fff" : "var(--text-primary)" }}
        onClick={toggleTeleprompter}
      >
        {tp.visible ? L("● 隐藏提词窗 (F2)", "● Hide prompter (F2)") : L("○ 显示提词窗 (F2)", "○ Show prompter (F2)")}
      </button>

      <textarea
        style={textarea}
        placeholder={L("在此输入讲稿，空行分段…（F2 显示悬浮提词窗，不会录进画面）", "Type your script here; blank lines = paragraph jumps… (F2 shows the floating window, never captured)")}
        value={tp.text}
        onChange={(e) => update({ text: e.target.value })}
        spellCheck={false}
      />
      <div style={row}>
        <button style={miniBtn} onClick={() => fileRef.current?.click()}>{L("📄 导入 .txt", "📄 Import .txt")}</button>
        <span style={meta}>{paras.length} {L("段", "par")} · {tp.text.length} {L("字", "ch")}</span>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".txt,text/plain"
        style={{ display: "none" }}
        onChange={(e) => {
          importTxt(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      <div style={row}>
        <span style={label}>{L("字号", "Font")} {tp.fontSize}</span>
        <input
          type="range" min={36} max={120} step={2}
          value={tp.fontSize}
          style={{ ...slider, flex: 1 }}
          onChange={(e) => update({ fontSize: Number(e.target.value) })}
        />
      </div>
      <div style={row}>
        <span style={label}>{L("速度 px/s", "Speed px/s")}</span>
        <input
          type="range" min={0} max={40} step={1}
          value={tp.speed}
          style={{ ...slider, flex: 1 }}
          onChange={(e) => update({ speed: Number(e.target.value) })}
        />
      </div>
      {tp.speed <= 0 && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
          {L("速度为 0：仅手动滚动（滚轮 / 方向键 / 分段跳转）", "Speed 0: manual only (wheel / arrows / paragraph jumps)")}
        </div>
      )}
      <div style={hint}>{L("提词窗为独立置顶悬浮窗，已从系统捕获中排除 —— 录屏、直播画面都不会出现它。", "The prompter is a floating always-on-top window, excluded from capture — it never appears in recordings or streams.")}</div>
    </div>
  );
}

const toggleBtn: React.CSSProperties = { width: "100%", padding: "8px 12px", borderRadius: "var(--radius-sm)", fontSize: 13, fontWeight: 600, color: "var(--text-primary)", transition: "background 0.2s", marginBottom: 8 };
const textarea: React.CSSProperties = {
  width: "100%", minHeight: 110, resize: "vertical", padding: 8, borderRadius: "var(--radius-sm)",
  background: "var(--bg-tertiary)", color: "var(--text-primary)", fontSize: 12, lineHeight: 1.55,
  border: "1px solid var(--border-default)", outline: "none", fontFamily: "var(--font-mono)",
};
const row: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, gap: 6 };
const label: React.CSSProperties = { fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap" };
const slider: React.CSSProperties = { width: 90, accentColor: "var(--accent)" };
const miniBtn: React.CSSProperties = { fontSize: 11, padding: "3px 9px", borderRadius: "var(--radius-sm)", background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-default)", cursor: "pointer" };
const meta: React.CSSProperties = { fontSize: 10, color: "var(--text-muted)" };
const hint: React.CSSProperties = { fontSize: 10, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 };