import { useStore } from "../../store";
import { open } from "@tauri-apps/plugin-dialog";
import { tauriInvoke } from "../../lib/tauri";
import { filmStripLayout, stripPosToMainMs, summarizeMarks, type FilmLayout } from "../../lib/filmstrip";
import { formatClock } from "../../recording/edl";
import type { EditEntry } from "../../recording/edl";
import { useLang } from "../../lib/useLang";

const CHIP: Record<string, { bg: string; icon: string }> = {
  cut: { bg: "var(--accent-danger)", icon: "✂" },
  mask: { bg: "#e8b64a", icon: "🛡" },
  speedup: { bg: "#be5a3b", icon: "⏩" },
};

/**
 * The film strip — [片头][主片][片尾] with live mark chips. This is the
 * "录屏即成片" statement piece: the strip IS the export structure.
 */
export function FilmStrip() {
  const L = useLang();
  const marks = useStore((s) => s.marks);
  const setMarks = useStore((s) => s.setMarks);
  const recording = useStore((s) => s.recording);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);

  const mainDurationMs = Math.max(
    recording.isRecording ? recording.elapsedMs : 0,
    marks.edits.reduce((a, e) => Math.max(a, e.endMs), 0),
  );
  const outputMainMs = mainDurationMs > 0 && marks.edits.length > 0
    ? outputDurationOf(marks.edits, mainDurationMs)
    : mainDurationMs;
  const layout: FilmLayout = filmStripLayout(
    mainDurationMs, marks.edits,
    settings.introPath ? settings.introDurationS * 1000 : 0,
    settings.outroPath ? settings.outroDurationS * 1000 : 0,
    outputMainMs,
  );
  const review = !recording.isRecording && !!ui.reviewPath;

  const onStripClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!review) return;
    const box = e.currentTarget.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
    const ms = stripPosToMainMs(pos, layout, mainDurationMs);
    setUi({ seekRequest: { ms, nonce: Date.now() } });
  };

  const attachEnd = async (which: "intro" | "outro") => {
    const picked = await open({ multiple: false, filters: [{ name: "视频", extensions: ["mp4", "webm", "mov", "mkv"] }] });
    if (typeof picked !== "string") return;
    const durS = await tauriInvoke<number>("probe_media_duration", { path: picked }).catch(() => 0);
    const durationS = durS > 0 ? Math.round(durS * 10) / 10 : 3;
    setSettings(which === "intro"
      ? { introPath: picked, introDurationS: durationS }
      : { outroPath: picked, outroDurationS: durationS });
  };

  const detachEnd = (which: "intro" | "outro") => {
    setSettings(which === "intro" ? { introPath: "", introDurationS: 3 } : { outroPath: "", outroDurationS: 3 });
  };

  const adjustMaskStart = async (index: number, deltaMs: number) => {
    const edit = marks.edits[index];
    if (!edit || edit.type !== "mask") return;
    const startMs = Math.max(0, edit.startMs + deltaMs);
    if (startMs >= edit.endMs - 500) return;
    const next: EditEntry = { ...edit, startMs, startSource: "manual" };
    setMarks({ edits: marks.edits.map((x, i) => (i === index ? next : x)) });
    try { await tauriInvoke("edl_update", { index, edit: next }); } catch { /* session closed */ }
  };

  const summary = summarizeMarks(marks.edits, {
    activePrivacy: !!marks.activePrivacy,
    activeFF: !!marks.activeFF,
    activePause: !!marks.activePause,
    activePrivacyCut: !!marks.activePrivacyCut,
  });

  return (
    <div style={styles.wrap}>
      <div style={styles.strip} onClick={onStripClick} className={review ? "strip-review" : ""}>
        {/* 片头 slot */}
        <EndSlot
          kind="intro"
          label={L("片头", "Intro")}
          attachTitle={L("附加片头视频", "Attach an intro clip")}
          attachHint={L("点击附加", "click to attach")}
          path={settings.introPath}
          durationS={settings.introDurationS}
          width={layout.segs[0].width}
          onAttach={() => void attachEnd("intro")}
          onDetach={() => detachEnd("intro")}
        />
        {/* 主片 */}
        <div style={{ ...styles.main, width: `${layout.segs[1].width}%` }}>
          <div style={styles.perfTop} />
          {mainDurationMs <= 0 ? (
            <span style={styles.mainEmpty}>- - - {L("等待开拍", "waiting to roll")} - - -</span>
          ) : (
            <span style={styles.mainLabel}>● {L("主片", "Main")} {formatClock(mainDurationMs)}</span>
          )}
          {/* Mark chips */}
          {marks.edits.map((e, i) => {
            const chip = CHIP[e.type] ?? CHIP.cut;
            const left = mainDurationMs > 0 ? (e.startMs / mainDurationMs) * 100 : 0;
            const width = mainDurationMs > 0 ? Math.max(1.2, ((e.endMs - e.startMs) / mainDurationMs) * 100) : 0;
            const label = e.type === "cut" && e.reason === "pause" ? "⏸" : chip.icon;
            return (
              <div key={i} style={{ ...styles.chip, left: `${left}%`, width: `${width}%`, background: chip.bg }} title={`${e.type} ${formatClock(e.startMs)} → ${formatClock(e.endMs)}`}>
                <span style={styles.chipIcon}>{label}</span>
              </div>
            );
          })}
          {/* Open marks: growing chip at the right edge */}
          {marks.activePrivacy && <div style={{ ...styles.chip, right: 0, width: "4%", background: CHIP.mask.bg }} title={L("遮挡中…", "Masking…")}>🛡</div>}
          {marks.activeFF && <div style={{ ...styles.chip, right: 0, width: "4%", background: CHIP.speedup.bg }} title={L("快进中…", "Fast-forwarding…")}>⏩</div>}
          {marks.activePrivacyCut && <div style={{ ...styles.chip, right: 0, width: "4%", background: CHIP.cut.bg }} title={L("隐私区间中…", "Privacy range…")}>🔒</div>}
          {marks.activePause && <div style={{ ...styles.chip, right: 0, width: "4%", background: "#9a8f7e" }} title={L("暂停中…", "Paused…")}>⏸</div>}
          <div style={styles.perfBottom} />
        </div>
        {/* 片尾 slot */}
        <EndSlot
          kind="outro"
          label={L("片尾", "Outro")}
          attachTitle={L("附加片尾视频", "Attach an outro clip")}
          attachHint={L("点击附加", "click to attach")}
          path={settings.outroPath}
          durationS={settings.outroDurationS}
          width={layout.segs[2].width}
          onAttach={() => void attachEnd("outro")}
          onDetach={() => detachEnd("outro")}
        />
      </div>

      {/* Review row: summary + mask adjust (privacy review safety net). */}
      {review && summary.cuts + summary.masks + summary.speedups + summary.pauses > 0 && (
        <div style={styles.summary}>
          <span style={styles.summaryText}>
            {L("成片约", "Film ≈")} {formatClock(layout.outputMs)} / {L("素材", "raw")} {formatClock(mainDurationMs)}
            {summary.cuts > 0 && ` · ✂${L("剪除", "cuts")}${summary.cuts}`}
            {summary.pauses > 0 && ` · ⏸${L("暂停", "pauses")}${summary.pauses}`}
            {summary.masks > 0 && ` · 🛡${L("遮挡", "masks")}${summary.masks}`}
            {summary.speedups > 0 && ` · ⏩${L("快进", "ff")}${summary.speedups}`}
          </span>
        </div>
      )}
      {review && marks.edits.some((e) => e.type === "mask") && (
        <div style={styles.review}>
          {marks.edits.map((e, i) => {
            if (e.type !== "mask") return null;
            return (
              <div key={i} style={styles.reviewRow}>
                <span style={styles.reviewTime}>
                  🛡 {formatClock(e.startMs)} → {formatClock(e.endMs)}
                  <span style={{ marginLeft: 6, color: "var(--text-muted)" }}>
                    ({e.startSource === "manual" ? L("手动", "manual") : e.startSource === "grace" ? L("宽限", "grace") : L("自动回溯", "auto-traced")})
                  </span>
                </span>
                <span style={styles.reviewBtns}>
                  <button style={styles.miniBtn} onClick={() => void adjustMaskStart(i, -1000)} title="起点前移 1 秒（多遮 1 秒）">−1s</button>
                  <button style={styles.miniBtn} onClick={() => void adjustMaskStart(i, 1000)} title="起点后移 1 秒">+1s</button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {marks.feedback && <div style={styles.feedback}>{marks.feedback}</div>}
    </div>
  );
}

function EndSlot(props: {
  kind: "intro" | "outro";
  label: string;
  attachTitle: string;
  attachHint: string;
  path: string;
  durationS: number;
  width: number;
  onAttach: () => void;
  onDetach: () => void;
}) {
  const attached = !!props.path;
  return (
    <div style={{ ...styles.end, width: `${props.width}%`, ...(attached ? styles.endOn : {}) }} title={props.path}>
      <div style={styles.perfTop} />
      {attached ? (
        <>
          <span style={styles.endOnText}>{props.label} ✓ {props.durationS}s</span>
          <button
            style={styles.endDetach}
            onClick={(e) => { e.stopPropagation(); props.onDetach(); }}
            title="移除"
          >✕</button>
        </>
      ) : (
        <button
          style={styles.endAttach}
          onClick={(e) => { e.stopPropagation(); props.onAttach(); }}
          title={props.attachTitle}
        >
          {props.label} +<span style={styles.endHint}>{props.attachHint}</span>
        </button>
      )}
      <div style={styles.perfBottom} />
    </div>
  );
}

function outputDurationOf(edits: EditEntry[], durationMs: number): number {
  // Cheap projection without importing the full timeline: sum kept spans.
  let out = 0;
  let src = 0;
  const sorted = [...edits].sort((a, b) => a.startMs - b.startMs);
  for (const e of sorted) {
    if (e.startMs >= durationMs) break;
    const end = Math.min(e.endMs, durationMs);
    if (e.type === "cut") {
      out += Math.max(0, Math.min(e.startMs, durationMs) - src);
      src = end;
    }
  }
  out += Math.max(0, durationMs - Math.max(src, 0));
  // Speedups compress; approximate by their target window.
  for (const e of edits) {
    if (e.type !== "speedup") continue;
    const srcLen = e.endMs - e.startMs;
    out -= srcLen;
    out += Math.max(e.targetSecs[0], Math.min(e.targetSecs[1], srcLen / 1000)) * 1000;
  }
  return Math.max(0, out);
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: 3, flexShrink: 0 },
  strip: {
    height: 52, display: "flex", gap: 3, background: "var(--bg-secondary)",
    borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)",
    padding: 4, cursor: "default", userSelect: "none",
  },
  main: {
    position: "relative", flex: 1, background: "var(--bg-primary)", borderRadius: 6,
    display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
    border: "1px solid var(--border-subtle)",
  },
  mainEmpty: { fontSize: 11, color: "var(--text-muted)", letterSpacing: 2 },
  mainLabel: { fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" },
  perfTop: {
    position: "absolute", top: 2, left: 4, right: 4, height: 3,
    background: "repeating-linear-gradient(90deg, var(--border-default) 0 3px, transparent 3px 8px)",
  },
  perfBottom: {
    position: "absolute", bottom: 2, left: 4, right: 4, height: 3,
    background: "repeating-linear-gradient(90deg, var(--border-default) 0 3px, transparent 3px 8px)",
  },
  chip: {
    position: "absolute", top: 9, bottom: 9, borderRadius: 3, opacity: 0.92,
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 1px 3px rgba(0,0,0,0.5)", animation: "chipPop 0.3s ease-out",
  },
  chipIcon: { fontSize: 10, lineHeight: 1, color: "#fff" },
  end: {
    position: "relative", width: "12%", minWidth: 64, background: "var(--bg-primary)",
    borderRadius: 6, border: "1px dashed var(--border-default)", display: "flex",
    alignItems: "center", justifyContent: "center", overflow: "hidden",
  },
  endOn: { borderStyle: "solid", borderColor: "var(--accent)", background: "rgba(99,130,255,0.08)" },
  endAttach: { background: "none", border: "none", color: "var(--text-muted)", fontSize: 11, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center" },
  endHint: { fontSize: 9, opacity: 0.6 },
  endOnText: { fontSize: 10, color: "var(--accent)", fontFamily: "var(--font-mono)" },
  endDetach: {
    position: "absolute", top: 8, right: 6, background: "none", border: "none",
    color: "var(--text-muted)", fontSize: 10, cursor: "pointer",
  },
  summary: { display: "flex", alignItems: "center", padding: "0 4px" },
  summaryText: { fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" },
  review: { display: "flex", flexDirection: "column", gap: 2 },
  reviewRow: { display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, padding: "2px 6px", background: "var(--bg-secondary)", borderRadius: 4 },
  reviewTime: { fontFamily: "var(--font-mono)", color: "var(--text-secondary)" },
  reviewBtns: { display: "flex", gap: 4 },
  miniBtn: { fontSize: 10, padding: "1px 7px", borderRadius: 3, border: "1px solid var(--border-default)", background: "var(--bg-tertiary)", color: "var(--text-primary)", cursor: "pointer" },
  feedback: { fontSize: 11, color: "var(--accent)", padding: "0 4px" },
};
