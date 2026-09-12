import { useStore } from "../../store";
import { useLang } from "../../lib/useLang";

/** Status strip: state badges + FPS + settings gear + the export primary CTA. */
export function StatusBar() {
  const L = useLang();
  const { isRecording, fps } = useStore((s) => s.recording);
  const marks = useStore((s) => s.marks);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);

  const reviewReady = !isRecording && !!ui.reviewPath;

  return (
    <div style={styles.bar}>
      <div style={styles.item}>
        <span style={isRecording ? styles.recDot : styles.dot}>●</span>
        <span style={{ fontSize: 11 }}>{isRecording ? L("录制中", "Recording") : L("空闲", "Idle")}</span>
        {marks.activePrivacy && <span style={styles.badgeYellow}>🛡 {L("遮挡中", "Masking")}</span>}
        {marks.privacyDrawing && <span style={styles.badgeYellow}>🛡 {L("框选中", "Drawing")}</span>}
        {marks.activePrivacyCut && <span style={styles.badgeRed}>🔒 {L("隐私区间", "Privacy span")}</span>}
        {marks.activeFF && <span style={styles.badgeBlue}>⏩ {L("快进中", "Fast-fwd")}</span>}
        {marks.activePause && <span style={styles.badgeYellow}>⏸ {L("已暂停", "Paused")}</span>}
      </div>
      <div style={styles.item}>
        <span style={styles.fps}>FPS: {fps}</span>
        <button style={styles.gear} onClick={() => setUi({ settingsOpen: true })} title={L("设置（快捷键 / 视频 / 音频 / 输出目录）", "Settings (shortcuts / video / audio / output)")}>⚙ {L("设置", "Settings")}</button>
        <button
          style={{
            ...styles.exportBtn,
            ...(reviewReady ? styles.exportBreath : {}),
            ...(ui.exportOpen ? styles.exportOpenStyle : {}),
          }}
          onClick={() => setUi({ exportOpen: !ui.exportOpen })}
          title={L("导出成片", "Export the film")}
        >
          📦 {L("导出成片", "Export film")}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    height: 40, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "0 12px", background: "var(--bg-secondary)", borderTop: "1px solid var(--border-subtle)",
  },
  item: { display: "flex", alignItems: "center", gap: 8 },
  recDot: { color: "var(--accent-danger)", fontSize: 11, animation: "pulse 1.5s infinite" },
  dot: { color: "var(--text-muted)", fontSize: 11 },
  badgeRed: { fontSize: 10, padding: "2px 9px", borderRadius: 10, background: "var(--accent-danger)", color: "#fff", fontWeight: 700 },
  badgeYellow: { fontSize: 10, padding: "2px 9px", borderRadius: 10, background: "#c9992a", color: "#fff", fontWeight: 700 },
  badgeBlue: { fontSize: 10, padding: "2px 9px", borderRadius: 10, background: "#be5a3b", color: "#fff", fontWeight: 700 },
  fps: { fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginRight: 8 },
  gear: {
    fontSize: 11, padding: "5px 12px", borderRadius: "var(--radius-sm)",
    background: "var(--bg-tertiary)", color: "var(--text-secondary)",
    border: "1px solid var(--border-default)", cursor: "pointer",
  },
  exportBtn: {
    fontSize: 12, fontWeight: 700, padding: "7px 18px", borderRadius: "var(--radius-sm)",
    background: "var(--bg-tertiary)", color: "var(--text-secondary)",
    border: "1px solid var(--border-default)", cursor: "pointer",
    transition: "all 0.2s",
  },
  exportBreath: {
    background: "var(--accent)", color: "#fff", borderColor: "var(--accent)",
    boxShadow: "0 0 12px var(--accent-glow)", animation: "exportBreath 2s infinite",
  },
  exportOpenStyle: { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" },
};
