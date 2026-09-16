import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import { tauriInvoke } from "../../lib/tauri";
import { formatClock } from "../../recording/edl";
import { AUTHOR_SHORT_ZH, AUTHOR_SHORT_EN } from "../../lib/authorStory";
import { useLang, isZhLang } from "../../lib/useLang";
import { dcMediaUrl } from "../../lib/mediaUrl";

interface RecordingEntry {
  webmPath: string;
  editsPath: string;
  finalized: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

interface LibraryItem extends RecordingEntry {
  edits: { cuts: number; masks: number; speedups: number; pauses: number };
  durationMs: number;
}

/** 素材库 — the archive half of the hub. Every recording, its marks, its ways out.
 *  Playback stays INSIDE the library (modal player): the studio tab always
 *  means the live stage, never "resume an old take". */
export function LibraryView({ visible }: { visible: boolean }) {
  const L = useLang();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<LibraryItem | null>(null);
  const playerRef = useRef<HTMLVideoElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await tauriInvoke<RecordingEntry[]>("list_recordings");
      const enriched: LibraryItem[] = [];
      for (const r of list ?? []) {
        let edits = { cuts: 0, masks: 0, speedups: 0, pauses: 0 };
        let durationMs = 0;
        try {
          const edl = await tauriInvoke<{ durationMs: number | null; edits: { type: string; reason?: string }[] }>("edl_get", { path: r.webmPath });
          if (edl) {
            durationMs = edl.durationMs ?? 0;
            const cuts = (edl.edits ?? []).filter((e) => e.type === "cut");
            edits = {
              cuts: cuts.filter((e) => e.reason !== "pause").length,
              pauses: cuts.filter((e) => e.reason === "pause").length,
              masks: (edl.edits ?? []).filter((e) => e.type === "mask").length,
              speedups: (edl.edits ?? []).filter((e) => e.type === "speedup").length,
            };
          }
        } catch { /* sidecar missing */ }
        enriched.push({ ...r, edits, durationMs });
      }
      setItems(enriched);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (visible) void refresh(); }, [visible, refresh]);

  // Tab hidden behind the studio: stop the sound, keep the modal selection.
  useEffect(() => {
    if (!visible) playerRef.current?.pause();
  }, [visible]);
  // ESC closes the player.
  useEffect(() => {
    if (!playing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPlaying(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing]);

  const timeAgo = (ms: number): string => {
    const diff = Date.now() - ms;
    const m = Math.floor(diff / 60000);
    const zh = isZhLang();
    if (m < 1) return zh ? "刚刚" : "just now";
    if (m < 60) return zh ? `${m} 分钟前` : `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return zh ? `${h} 小时前` : `${h}h ago`;
    return zh ? `${Math.floor(h / 24)} 天前` : `${Math.floor(h / 24)}d ago`;
  };

  const totalBytes = items.reduce((a, i) => a + i.sizeBytes, 0);

  return (
    <div style={{ ...styles.wrap, display: visible ? "flex" : "none" }}>
      <div style={styles.head}>
        <span style={styles.title}>
          {items.length} 个录像 · 共 {(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={styles.btn} onClick={() => void refresh()}>↻ {L("刷新", "Refresh")}</button>
          <button style={styles.btn} onClick={() => tauriInvoke("open_folder", { path: "" }).catch(() => {})}>📁 {L("打开目录", "Open folder")}</button>
        </div>
      </div>

      {loading && <div style={styles.empty}>{L("读取中…", "Loading…")}</div>}
      {!loading && items.length === 0 && (
        <div style={styles.empty}>
          <div style={{ fontSize: 40, opacity: 0.5 }}>🎬</div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{L("还没有录像 — 去工作台按 F9 开拍", "No recordings yet — hit F9 in the Studio")}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.8, maxWidth: 420, marginTop: 8, whiteSpace: "pre-line" }}>
            {L("关于简录", "About EaseRec")}：{L(AUTHOR_SHORT_ZH, AUTHOR_SHORT_EN)}
          </div>
        </div>
      )}

      <div style={styles.grid}>
        {items.map((it) => {
          const markCount = it.edits.cuts + it.edits.masks + it.edits.speedups + it.edits.pauses;
          return (
            <div
              key={it.webmPath}
              style={{ ...styles.card, ...(it.finalized ? {} : styles.cardUnfinished), cursor: "pointer" }}
              onClick={() => setPlaying(it)}
              title={L("点击播放", "Click to play")}
            >
              <div style={styles.thumb}>
                {it.finalized ? "▶" : "⚠"}
              </div>
              <div style={styles.cardBody}>
                <div style={styles.cardTitle} title={it.webmPath}>
                  {it.webmPath.split(/[\\/]/).pop()}
                </div>
                <div style={styles.cardMeta}>
                  {it.durationMs > 0 ? formatClock(it.durationMs) : `${(it.sizeBytes / 1024 / 1024).toFixed(0)} MB`}
                  {" · "}{timeAgo(it.mtimeMs)}
                </div>
                <div style={styles.cardMarks}>
                  {markCount > 0 ? (
                    <>
                      {it.edits.cuts > 0 && <span style={styles.markTag}>✂{it.edits.cuts}</span>}
                      {it.edits.pauses > 0 && <span style={styles.markTag}>⏸{it.edits.pauses}</span>}
                      {it.edits.masks > 0 && <span style={{ ...styles.markTag, background: "rgba(232,182,74,0.2)" }}>🛡{it.edits.masks}</span>}
                      {it.edits.speedups > 0 && <span style={{ ...styles.markTag, background: "rgba(90,162,255,0.2)" }}>⏩{it.edits.speedups}</span>}
                    </>
                  ) : (
                    <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{L("无标记", "No marks")}</span>
                  )}
                  {!it.finalized && <span style={{ ...styles.markTag, background: "rgba(232,182,74,0.25)" }}>{L("未正常结束", "Unfinished")}</span>}
                </div>
                <div style={styles.cardActions}>
                  <button style={styles.primary} onClick={(e) => { e.stopPropagation(); setPlaying(it); }} title={L("在素材库内播放预览", "Preview inside the library")}>
                    {L("播放", "Play")}
                  </button>
                  <button style={styles.btn} onClick={(e) => { e.stopPropagation(); tauriInvoke("open_folder", { path: it.webmPath.replace(/[\\/][^\\/]+$/, "") }).catch(() => {}); }}>目录</button>
                  {!it.finalized && (
                    <button style={styles.btn} title={L("忽略恢复提示", "Dismiss recovery")} onClick={async (e) => {
                      e.stopPropagation();
                      await tauriInvoke("recording_mark_finalized", { webmPath: it.webmPath }).catch(() => {});
                      void refresh();
                    }}>{L("忽略", "Dismiss")}</button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* In-library player: preview without ever touching the studio's state.
          key= remounts per item so one take ending never poisons the next. */}
      {playing && (
        <div style={styles.playerMask} onClick={() => setPlaying(null)}>
          <div style={styles.playerCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.playerHead}>
              <span style={styles.playerTitle} title={playing.webmPath}>
                {playing.webmPath.split(/[\\/]/).pop()}
              </span>
              <span style={styles.playerMeta}>
                {playing.durationMs > 0 ? formatClock(playing.durationMs) : `${(playing.sizeBytes / 1024 / 1024).toFixed(0)} MB`}
                {" · "}{timeAgo(playing.mtimeMs)}
              </span>
              <button style={styles.playerClose} onClick={() => setPlaying(null)} title={L("关闭 (Esc)", "Close (Esc)")}>✕</button>
            </div>
            <video
              ref={playerRef}
              key={playing.webmPath}
              src={dcMediaUrl(playing.webmPath)}
              controls
              autoPlay
              style={styles.playerVideo}
            />
          </div>
        </div>
      )}

      <div style={styles.footer}>
        <span>© 2026 {L("简录 EaseRec · 让知识输出回归纯粹", "EaseRec — recording, simplified")}</span>
        <button style={styles.footerBtn} onClick={() => useStore.getState().setUi({ settingsOpen: true })}>
          {L("☕ 支持简录", "☕ Support us")}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { flex: 1, display: "flex", flexDirection: "column", padding: 14, overflowY: "auto", gap: 12 },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" },
  btn: {
    fontSize: 11, padding: "5px 12px", borderRadius: "var(--radius-sm)",
    background: "var(--bg-tertiary)", color: "var(--text-primary)",
    border: "1px solid var(--border-default)", cursor: "pointer",
  },
  primary: {
    fontSize: 11, fontWeight: 700, padding: "5px 14px", borderRadius: "var(--radius-sm)",
    background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer",
  },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: 60 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 12 },
  card: {
    background: "var(--bg-secondary)", borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-subtle)", overflow: "hidden", display: "flex",
  },
  cardUnfinished: { borderColor: "rgba(232,182,74,0.5)" },
  thumb: {
    width: 64, display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 22, color: "var(--text-muted)", background: "var(--bg-primary)", flexShrink: 0,
  },
  cardBody: { flex: 1, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  cardTitle: { fontSize: 12, fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  cardMeta: { fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" },
  cardMarks: { display: "flex", gap: 4, flexWrap: "wrap" },
  markTag: { fontSize: 10, padding: "1px 6px", borderRadius: 6, background: "rgba(255,69,96,0.15)", color: "var(--text-secondary)" },
  cardActions: { display: "flex", gap: 6, marginTop: 4 },
  playerMask: {
    position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.62)",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  playerCard: {
    width: "min(880px, 88vw)", background: "var(--bg-secondary)",
    border: "1px solid var(--border-default)", borderRadius: "var(--radius-md)",
    overflow: "hidden", boxShadow: "0 18px 60px rgba(0,0,0,0.5)",
  },
  playerHead: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--border-subtle)" },
  playerTitle: { fontSize: 12, fontWeight: 600, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 },
  playerMeta: { fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 },
  playerClose: { background: "none", border: "none", color: "var(--text-secondary)", fontSize: 13, cursor: "pointer", flexShrink: 0, padding: "0 2px" },
  playerVideo: { display: "block", width: "100%", maxHeight: "70vh", background: "#000", objectFit: "contain" },
  footer: { marginTop: 18, paddingTop: 10, borderTop: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10, color: "var(--text-muted)" },
  footerBtn: { fontSize: 10, padding: "3px 10px", borderRadius: 8, background: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-default)", cursor: "pointer" },
};
