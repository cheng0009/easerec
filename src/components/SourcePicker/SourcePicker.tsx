import { useEffect, useState } from "react";
import { useStore } from "../../store";
import { tauriInvoke } from "../../lib/tauri";
import { useLang } from "../../lib/useLang";
import { getDirector } from "../../recording/director";


interface SourceItem {
  id: string;
  name: string;
  kind: "screen" | "window";
  displayId: string;
  thumb: string;
}

/** Full-screen-over-app modal for choosing the capture source (screen/window). */
export function SourcePicker() {
  const L = useLang();
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const setRecording = useStore((s) => s.setRecording);
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ui.sourcePickerOpen) return;
    setLoading(true);
    void tauriInvoke<SourceItem[]>("list_sources").then((list) => {
      // Screens first, then windows; filter tiny/hidden windows noise.
      const sorted = [...(list ?? [])].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "screen" ? -1 : 1));
      setSources(sorted);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [ui.sourcePickerOpen]);

  if (!ui.sourcePickerOpen) return null;

  const choose = (s: SourceItem) => {
    setRecording({
      sourceId: s.id,
      sourceName: s.kind === "screen" ? `🖥 ${s.name}` : `🪟 ${s.name.slice(0, 28)}`,
      sourceKind: s.kind,
      regionMode: false,
      regionRect: null,
    });
    void applySource(s.id);
    setUi({ sourcePickerOpen: false });
  };

  const applySource = (sourceId: string | null) => {
    return getDirector().recorder.switchSource(sourceId)
      .then((ok) => {
        useStore.getState().setMarks({
          feedback: ok
            ? L("✓ 已切换到所选画面源", "✓ Switched to the selected source")
            : L("⚠ 该画面源暂时无法采集，已保留上一个画面", "⚠ Source unavailable, previous feed retained"),
        });
      })
      .catch((e) => {
        console.error("[SourcePicker] switch failed:", e);
        useStore.getState().setMarks({ feedback: String(e) });
      });
  };

  // const chooseRegion = () => {
  //   // Region mode: primary-screen capture + overlay box selection at record
  //   // start (the recorder draws the selection rect before rolling).
  //   setRecording({ sourceId: null, sourceName: `⬚ ${L("框选区域", "Region")}`, sourceKind: "screen", regionMode: true, regionRect: null });
  //   setUi({ sourcePickerOpen: false });
  // };

  return (
    <div style={styles.mask} onClick={() => setUi({ sourcePickerOpen: false })}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.head}>
          <span style={styles.title}>{L("选择画面源", "Pick a capture source")}</span>
          <button style={styles.close} onClick={() => setUi({ sourcePickerOpen: false })}>✕</button>
        </div>
        <div style={styles.hint}>{L("录制整个屏幕或某个窗口；隐私遮挡框需要落在所选画面内。", "Record a whole screen or a window; privacy mask boxes must fall inside the captured frame.")}</div>
        <div style={styles.quickRow}>
          <button style={styles.quickBtn} onClick={() => { setRecording({ sourceId: null, sourceName: `🖥 ${L("主显示器", "Primary display")}`, sourceKind: "screen", regionMode: false, regionRect: null }); void applySource(null); setUi({ sourcePickerOpen: false }); }}>
            🖥 {L("主显示器", "Primary display")}
          </button>
          {/* <button style={styles.quickBtn} onClick={chooseRegion}>
            ⬚ {L("框选区域", "Select region")}
          </button> */}
        </div>
        <div style={styles.grid}>
          {loading && <div style={styles.loading}>{L("枚举中…", "Enumerating…")}</div>}
          {!loading && sources.length === 0 && <div style={styles.loading}>{L("没有可用的画面源", "No capture sources found")}</div>}
          {sources.map((s) => (
            <button key={s.id} style={styles.card} onClick={() => choose(s)} title={s.name}>
              <div style={styles.thumbWrap}>
                {s.thumb ? <img src={s.thumb} style={styles.thumb} alt="" /> : <div style={styles.thumbEmpty}>🖥</div>}
                <span style={styles.kind}>{s.kind === "screen" ? L("屏幕", "Screen") : L("窗口", "Window")}</span>
              </div>
              <div style={styles.name}>{s.name}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  mask: {
    position: "fixed", inset: 0, zIndex: 100, background: "var(--mask-bg)",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  panel: {
    width: 640, maxHeight: "80%", overflowY: "auto", background: "var(--bg-secondary)",
    border: "1px solid var(--border-default)", borderRadius: "var(--radius-lg)", padding: 16,
  },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  title: { fontSize: 15, fontWeight: 700, color: "var(--text-primary)" },
  close: { background: "none", border: "none", color: "var(--text-muted)", fontSize: 14, cursor: "pointer" },
  hint: { fontSize: 11, color: "var(--text-muted)", marginBottom: 12 },
  quickRow: { display: "flex", gap: 8, marginBottom: 10 },
  quickBtn: {
    flex: 1, padding: "8px 10px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 600,
    background: "var(--bg-tertiary)", color: "var(--text-primary)",
    border: "1px solid var(--border-default)", cursor: "pointer",
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 },
  loading: { gridColumn: "1 / -1", textAlign: "center", fontSize: 12, color: "var(--text-muted)", padding: 30 },
  card: {
    background: "var(--bg-primary)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-md)",
    padding: 8, cursor: "pointer", textAlign: "left", transition: "border-color 0.15s",
  },
  thumbWrap: { position: "relative", aspectRatio: "16/9", background: "#000", borderRadius: 6, overflow: "hidden", marginBottom: 6 },
  thumb: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  thumbEmpty: { width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 },
  kind: {
    position: "absolute", left: 6, top: 6, fontSize: 9, padding: "1px 6px", borderRadius: 6,
    background: "rgba(10,12,18,0.85)", color: "var(--text-secondary)",
  },
  name: { fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
};
