import { useStore } from "../../store";
import { tauriInvoke } from "../../lib/tauri";
import { card, sectionHeader } from "../../styles/components/panel";
import { useLang } from "../../lib/useLang";

export function StudioPanel() {
  const L = useLang();
  const studio = useStore((s) => s.studio);
  const setStudio = useStore((s) => s.setStudio);

  const toggle = async () => {
    const next = !studio.isActive;
    setStudio({ isActive: next });
    try {
      await tauriInvoke("toggle_studio_mode", { on: next, backgroundColor: studio.backgroundColor });
    } catch (e) {
      console.error("[studio] toggle failed:", e);
    }
  };

  return (
    <div style={{ ...card, borderColor: studio.isActive ? "var(--accent)" : "var(--border-subtle)" }}>
      <h3 style={sectionHeader}>
        {studio.isActive ? L("🔕 纯净舞台", "🔕 Pure stage") : L("🔔 纯净舞台", "🔔 Pure stage")}
      </h3>

      <button style={{
        ...btn,
        background: studio.isActive ? "var(--accent)" : "var(--bg-tertiary)",
        color: studio.isActive ? "#fff" : "var(--text-primary)",
      }} onClick={toggle}>
        {studio.isActive ? L("ON — 桌面已纯净", "ON — desktop decluttered") : "OFF"}
      </button>

      <p style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
        {L("隐藏桌面图标 + 底层纯色背景，录制画面干净专业。", "Hides desktop icons and lays a clean backdrop under your capture.")}
        {" "}{L("用", "Toggle with")} <b>F1</b> {L("随时切换。", "anytime.")}
      </p>
    </div>
  );
}

const btn: React.CSSProperties = { width: "100%", padding: "10px", borderRadius: "var(--radius-sm)", fontSize: 13, fontWeight: 700, border: "none", cursor: "pointer", transition: "background 0.2s" };
