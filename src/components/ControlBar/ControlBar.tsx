import { useState } from "react";
import { useStore } from "../../store";
import { useTauriEvent } from "../../hooks/useTauriEvent";
import { toggleRecording } from "../../recording/startRecording";
import { useLang, isZhLang } from "../../lib/useLang";
import {
  toggleFF,
  togglePrivacy,
  togglePrivacyCut,
  togglePause,
} from "../../recording/marks";

function dcInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const g = globalThis as unknown as {
    __directorcam?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T> };
  };
  if (!g.__directorcam) return Promise.reject(new Error("bridge unavailable"));
  return g.__directorcam.invoke(cmd, args);
}

/** Record / pause / snapshot / mark controls — the directing console. */
export function ControlBar() {
  const L = useLang();
  const recording = useStore((s) => s.recording);
  const marks = useStore((s) => s.marks);
  const setMarks = useStore((s) => s.setMarks);
  const setUi = useStore((s) => s.setUi);
  const [lastSavePath, setLastSavePath] = useState<string | null>(
    () => { try { return localStorage.getItem("dc_last_save"); } catch { return null; } }
  );

  useTauriEvent<{ level: string; message: string }>("app-notification", (p) => {
    if (p.message.toLowerCase().includes("saved")) {
      const path = p.message.replace(/^Video saved: /, "").trim();
      setLastSavePath(path);
      try { localStorage.setItem("dc_last_save", path); } catch {}
    }
  });

  const onToggleRecording = async () => {
    try {
      const savePath = await toggleRecording();
      if (savePath) {
        setLastSavePath(savePath);
        // 高光时刻：停止即出成片 — 自动进入回放并呼吸提示导出。
        setUi({ reviewPath: savePath });
      }
    } catch (e) { console.error("Toggle recording failed:", e); }
  };

  const onSnapshot = async () => {
    try {
      const dir = (await import("../../recording/director")).getDirector();
      const canvas = dir.recorder.compositeCanvasPublic;
      if (!canvas || canvas.width === 0) return;
      const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
      if (!blob) return;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const p = await dcInvoke<string | null>("save_screenshot", { bytes });
      if (p) setMarks({ feedback: (isZhLang() ? "📸 截图已保存：" : "📸 Saved: ") + p.split(/[\\/]/).pop() });
    } catch (e) { console.error("snapshot failed:", e); }
  };

  // Pause-aware timer.
  const displayMs = recording.elapsedMs - recording.pausedMs -
    (recording.isPaused && marks.activePause
      ? Math.max(0, Date.now() - marks.activePause.startMs) : 0);
  const formatTime = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
    return `${h.toString().padStart(2,"0")}:${(m%60).toString().padStart(2,"0")}:${(s%60).toString().padStart(2,"0")}`;
  };

  const openSaveFolder = () => {
    if (lastSavePath) { const dir = lastSavePath.replace(/[\\/][^\\/]+$/, ""); dcInvoke("open_folder", { path: dir }).catch(() => {}); }
  };

  return (
    <div style={styles.bar}>
      <button
        style={{ ...styles.recBtn, background: recording.isRecording ? "var(--accent-danger)" : "var(--accent)", animation: recording.isRecording ? "recFlashing 1s infinite" : "none" }}
        onClick={onToggleRecording}
        title={recording.isRecording ? "停止 (F9)" : "开始录制 (F9)"}
      >
        {recording.isRecording ? L("⬛ 停止", "⬛ Stop") : L("⏺ 录制", "⏺ Record")}
      </button>

      {recording.isRecording && (
        <button style={{ ...styles.ctrlBtn, ...(marks.activePause ? styles.onWarn : {}) }} onClick={() => void togglePause()} title={L("暂停/恢复 (F10) — 暂停段不会出现在成片里", "Pause/resume (F10) — paused span is cut from the film")}>
          {marks.activePause ? L("▶ 恢复", "▶ Resume") : L("⏸ 暂停", "⏸ Pause")}
        </button>
      )}

      <span style={styles.timer}>{formatTime(displayMs)}</span>

      {recording.isRecording ? (
        <div style={styles.marks}>
          <button style={{ ...styles.markBtn, ...(marks.activeFF ? styles.onBlue : {}) }} onClick={() => void toggleFF()} title={L("快进模式 (F4) — 导出时压缩为 3-5 秒", "Fast-forward (F4) — compressed to 3-5s at export")}>
            {marks.activeFF ? L("⏩ 快进中", "⏩ FF on") : L("⏩ 快进", "⏩ Fast-fwd")}
          </button>
          <button style={{ ...styles.markBtn, ...(marks.activePrivacy || marks.privacyDrawing ? styles.onYellow : {}) }} onClick={() => void togglePrivacy()} title={L("隐私遮挡 (F6) — 框选区域，自动回溯，画框前的泄露段自动剪除", "Privacy mask (F6) — box the region; auto backtrace + the exposed pre-box window is cut")}>
            {marks.activePrivacy ? L("🛡 结束遮挡", "🛡 End mask") : marks.privacyDrawing ? L("🛡 拖拽框选…", "🛡 Draw box…") : L("🛡 遮挡", "🛡 Mask")}
          </button>
          <button style={{ ...styles.markBtn, ...(marks.activePrivacyCut ? styles.onRed : {}) }} onClick={() => void togglePrivacyCut()} title={L("整段隐私剪除 (Shift+F6) — 登录/输密码等私密操作", "Privacy span (Shift+F6) — logins, passwords, private ops")}>
            {marks.activePrivacyCut ? L("🔒 剪除中", "🔒 Cutting") : L("🔒 隐私段", "🔒 Privacy span")}
          </button>
          <span style={styles.sep} />
          <button style={styles.markBtn} onClick={() => void onSnapshot()} title="截取当前画面为 PNG">📸</button>
        </div>
      ) : (
        <div style={styles.idleHint}>{L("F9 录制 · F10 暂停 · F4 快进 · F6 遮挡 · Shift+F6 隐私段", "F9 rec · F10 pause · F4 fast-fwd · F6 mask · Shift+F6 privacy")}</div>
      )}

      <div style={{ flex: 1 }} />
      {lastSavePath && !recording.isRecording && (
        <button style={styles.fileChip} onClick={openSaveFolder} title={lastSavePath}>
          📁 {lastSavePath.split(/[\\/]/).pop()}
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    height: 50, display: "flex", alignItems: "center", gap: 10, padding: "0 12px",
    background: "var(--bg-secondary)", borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-subtle)", flexShrink: 0,
  },
  recBtn: {
    padding: "8px 20px", borderRadius: "var(--radius-sm)", fontSize: 14, fontWeight: 700,
    color: "#fff", letterSpacing: 1, border: "none", cursor: "pointer",
    transition: "background 0.2s, transform 0.15s",
  },
  ctrlBtn: {
    padding: "7px 14px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 600,
    color: "var(--text-primary)", background: "var(--bg-tertiary)",
    border: "1px solid var(--border-default)", cursor: "pointer",
  },
  timer: { fontFamily: "var(--font-mono)", fontSize: 19, fontWeight: 600, color: "var(--text-primary)", minWidth: 96, textAlign: "center" },
  marks: { display: "flex", alignItems: "center", gap: 6 },
  markBtn: {
    padding: "7px 11px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 600,
    color: "var(--text-primary)", background: "var(--bg-tertiary)",
    border: "1px solid var(--border-default)", cursor: "pointer",
    transition: "all 0.15s",
  },
  sep: { width: 1, height: 22, background: "var(--border-default)", margin: "0 2px" },
  onRed: { background: "var(--accent-danger)", borderColor: "var(--accent-danger)", color: "#fff" },
  onBlue: { background: "#be5a3b", borderColor: "#be5a3b", color: "#fff" },
  onYellow: { background: "#c9992a", borderColor: "#c9992a", color: "#fff" },
  onWarn: { background: "#c9992a", borderColor: "#c9992a", color: "#fff" },
  idleHint: { fontSize: 11, color: "var(--text-muted)" },
  fileChip: {
    maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    fontSize: 11, color: "var(--text-secondary)", background: "var(--bg-primary)",
    border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "4px 10px", cursor: "pointer",
  },
};
