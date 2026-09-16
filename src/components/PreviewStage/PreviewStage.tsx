import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import { getDirector } from "../../recording/director";
import { dcMediaUrl } from "../../lib/mediaUrl";
import { useLang } from "../../lib/useLang";
import bannerUrl from "../../assets/banner.png";

/**
 * The 成片画布 — the heart of the hub. Three states:
 *   idle      → personal banner + selling-point chips + source chip
 *   recording → live composed preview (what you see IS what's recorded)
 *   review    → playback of the finished recording (seekable)
 * Overlay badges show the ACTUAL effective parameters (they live in this
 * window, never on the captured desktop overlay).
 */
export function PreviewStage() {
  const L = useLang();
  const isRecording = useStore((s) => s.recording.isRecording);
  const reviewPath = useStore((s) => s.ui.reviewPath);
  const seekRequest = useStore((s) => s.ui.seekRequest);
  const setUi = useStore((s) => s.setUi);
  const exportOpen = useStore((s) => s.ui.exportOpen);
  const recording = useStore((s) => s.recording);
  const activePause = useStore((s) => s.marks.activePause);
  // The stage stays mounted while the library tab is in front (both views are
  // kept alive) — visibility only decides whether to paint/pause.
  const studioVisible = useStore((s) => s.ui.view) === "studio";

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [hasFrame, setHasFrame] = useState(false);
  // Review length comes from the file itself (a take opened from the library
  // has no elapsed-time state to fall back on). Infinity happens on streamed
  // webm — fall back to the session timer then.
  const [reviewDurMs, setReviewDurMs] = useState(0);
  // Next-step guide: dismissed per take — takeId (bumped at every start)
  // identities the take WITHOUT depending on the saved file path.
  const takeId = useStore((s) => s.marks.takeId);
  const [ctaDismissed, setCtaDismissed] = useState<number | null>(null);
  const [bannerVisible, setBannerVisible] = useState(() => {
    // Session-only dismissal: reappears after a restart, stays hidden after
    // the user closes it or starts recording — the top-right button reopens.
    try { return sessionStorage.getItem("dc_banner_hidden") !== "1"; } catch { return true; }
  });
  const wasRecording = useRef(false);
  // Never let the splash ride on the recorded video: dismiss it the instant a
  // recording starts (kept for the session), and the idle stage behind it
  // always shows the live preview — closing the banner reveals the preview.
  useEffect(() => {
    if (isRecording && !wasRecording.current) {
      setBannerVisible(false);
      try { sessionStorage.setItem("dc_banner_hidden", "1"); } catch {}
    }
    wasRecording.current = isRecording;
  }, [isRecording]);
  const webcamOn = useStore((s) => s.webcam.enabled);
  const webcamRaised = useRef(false);
  useEffect(() => {
    // Starting the camera means the user wants to SEE the live preview —
    // drop the splash automatically and go straight to the screen+cam view.
    if (webcamOn && !webcamRaised.current) {
      setBannerVisible(false);
      try { sessionStorage.setItem("dc_banner_hidden", "1"); } catch {}
    }
    webcamRaised.current = webcamOn;
  }, [webcamOn]);
  const idle = !isRecording && !reviewPath;

  // Live composed preview while not in review. When the follow-focus feature
  // is enabled the recorded stream stays 1:1 — the zoom is rendered at
  // export — so the preview draws the FOCUS BOX the export will produce,
  // keeping the WYSIWYG promise ("预览框 = 导出时的放大区域").
  useEffect(() => {
    if (reviewPath || !studioVisible) return;
    let raf: number | null = null;
    const draw = () => {
      const dir = getDirector();
      const src = dir.recorder.compositeCanvasPublic;
      const canvas = canvasRef.current;
      if (src && src.width > 0) {
        // The composed preview (real screen + webcam PiP) is a LIVE source the
        // moment capture/compositing is up — flip hasFrame even before the
        // canvas element has mounted so the idle stage shows the preview
        // instead of being stuck on the empty screen (the canvas paints on
        // the next rAF). Without this the preview only ever appears after the
        // first recording, and enabling the camera shows no reaction.
        if (!hasFrame) setHasFrame(true);
        if (canvas) {
          const ctx = canvas.getContext("2d");
          if (ctx) {
            if (canvas.width !== src.width) canvas.width = src.width;
            if (canvas.height !== src.height) canvas.height = src.height;
            ctx.drawImage(src, 0, 0);
            const focus = dir.recorder.focusPreview;
            if (focus && focus.scale > 1.03) {
              const vw = canvas.width / focus.scale;
              const vh = canvas.height / focus.scale;
              const fx = Math.max(0, Math.min(canvas.width - vw, focus.cx * canvas.width - vw / 2));
              const fy = Math.max(0, Math.min(canvas.height - vh, focus.cy * canvas.height - vh / 2));
              ctx.save();
              ctx.strokeStyle = "rgba(99,130,255,0.9)";
              ctx.lineWidth = Math.max(2, canvas.width * 0.0022);
              ctx.setLineDash([Math.max(8, canvas.width * 0.012), Math.max(6, canvas.width * 0.009)]);
              ctx.strokeRect(fx, fy, vw, vh);
              ctx.setLineDash([]);
              ctx.fillStyle = "rgba(99,130,255,0.85)";
              ctx.font = `bold ${Math.max(11, canvas.width * 0.012)}px system-ui, sans-serif`;
              ctx.textAlign = "left";
              ctx.textBaseline = "bottom";
              ctx.fillText("⤢ " + L("导出时放大此区域", "Zoomed at export"), fx + 4, Math.max(12, fy - 4));
              ctx.restore();
            }
          }
        }
      } else if (!dir.recorder.hasPreviewSource && hasFrame) {
        // Nothing live left (e.g. webcam stopped with no screen capture):
        // leave the dead composed frame and fall back to the empty stage.
        setHasFrame(false);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [reviewPath, studioVisible, hasFrame, L]);

  // Hidden behind the library tab: pause review playback but keep the
  // position, so coming back resumes exactly where the user left off.
  useEffect(() => {
    if (!studioVisible) videoRef.current?.pause();
  }, [studioVisible]);

  // A fresh take invalidates the previous file duration.
  useEffect(() => { setReviewDurMs(0); }, [reviewPath]);
  // Opening the export drawer IS the guided next step — retire the guide for
  // this take instead of popping back up when the drawer closes.
  useEffect(() => {
    if (exportOpen) setCtaDismissed(takeId);
  }, [exportOpen, takeId]);

  // Seek requests from the film strip.
  useEffect(() => {
    if (seekRequest && videoRef.current) {
      videoRef.current.currentTime = seekRequest.ms / 1000;
      void videoRef.current.play().catch(() => {});
      setUi({ seekRequest: null });
    }
  }, [seekRequest, setUi]);

  const elapsed = recording.elapsedMs - recording.pausedMs -
    (recording.isPaused && activePause ? Math.max(0, Date.now() - activePause.startMs) : 0);
  // Take length: file metadata when known, session timer otherwise.
  const reviewLenMs = reviewDurMs || Math.max(0, recording.elapsedMs - recording.pausedMs);
  const fmt = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const settings = useStore.getState().settings;

  return (
    <div ref={stageRef} style={styles.stage}>
      {/* LIVE / finished badges */}
      {isRecording && (
        <div style={{ ...styles.badge, top: 10, left: 10, background: "rgba(255,69,96,0.9)" }}>
          <span style={styles.liveDot} /> LIVE {fmt(elapsed)}
        </div>
      )}
      {isRecording && recording.isPaused && (
        <div style={{ ...styles.badge, top: 10, left: 100, background: "var(--chip-solid)" }}>
          ⏸ {L("已暂停", "Paused")}
        </div>
      )}
      {!isRecording && reviewPath && (
        <div style={{ ...styles.badge, top: 10, left: 10, background: "var(--accent-success)" }}>
          ✅ {L("回放", "Review")} {fmt(reviewLenMs)}
        </div>
      )}

      {/* Next-step guide: the take just landed and the one action that matters
          now is exporting. Keyed on takeId (not the file path) so it shows
          even if the save path came back empty. Dismissed per take, or
          retired once the export drawer has been opened. */}
      {!isRecording && reviewLenMs > 0 && !exportOpen && ctaDismissed !== takeId && (
        <div style={styles.ctaWrap}>
          <div style={styles.ctaBar}>
            <span style={styles.ctaText}>
              🎬 {L("素材已就绪", "Take saved")} · {fmt(reviewLenMs)} · {L("下一步：导出成片", "Next: export the film")}
            </span>
            <button style={styles.ctaBtn} onClick={() => setUi({ exportOpen: true })}>
              📦 {L("导出成片", "Export film")} →
            </button>
            <button
              style={styles.ctaClose}
              onClick={() => setCtaDismissed(takeId)}
              title={L("关闭提示", "Dismiss")}
            >✕</button>
          </div>
        </div>
      )}

      {/* Actual-parameter badges (bottom). */}
      {(isRecording || hasFrame) && !reviewPath && (
        <div style={{ ...styles.badge, bottom: 10, right: 10 }}>
          {(recording.sourceName === "主显示器" ? L("主显示器", "Primary display") : recording.sourceName) || L("主显示器", "Primary display")} · {settings.resolution.width}×{settings.resolution.height} · {settings.fps}fps
        </div>
      )}

      {/* State content. */}
      {reviewPath ? (
        <video
          ref={videoRef}
          src={dcMediaUrl(reviewPath)}
          controls
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setReviewDurMs(Math.round(d * 1000));
          }}
          style={styles.video}
        />
      ) : !bannerVisible && (hasFrame || isRecording) ? (
        <canvas ref={canvasRef} style={styles.video} />
      ) : (
        <EmptyStage />
      )}

      {/* Idle controls (source + audio pickers) — always visible while idle,
          over both the empty background and the live preview. */}
      {idle && <IdleControls />}

      {/* Splash banner: floats over the EMPTY idle stage (no live preview
          behind it until the splash is closed). Close → shrink toward the
          top-right button; reopen → grow back into the center. */}
      {idle && bannerVisible && (
        <BannerOverlay
          bannerUrl={bannerUrl}
          closeTargetRect={() => {
            const r = stageRef.current?.getBoundingClientRect();
            return r ? { x: r.right - 25, y: r.top + 25 } : null;
          }}
          onClose={() => {
            setBannerVisible(false);
            try { sessionStorage.setItem("dc_banner_hidden", "1"); } catch {}
          }}
        />
      )}
      {idle && !bannerVisible && (
        <button
          style={styles.bannerReopen}
          onClick={() => {
            setBannerVisible(true);
            try { sessionStorage.removeItem("dc_banner_hidden"); } catch {}
          }}
          title={L("展开开屏图", "Show splash")}
        >🖼</button>
      )}
    </div>
  );
}

function EmptyStage() {
  const L = useLang();
  return (
    <div style={styles.empty}>
      <div style={styles.emptyHint}>
        {L("选择画面源后，这里实时显示屏幕与摄像头预览", "Live screen + camera preview appears here once a source is selected")}
      </div>
    </div>
  );
}

/** Idle-only bottom bar: source picker + audio source + quick settings
 *  shortcuts. Lives OUTSIDE the empty stage so it also floats over the live
 *  preview after the splash is closed. */
function IdleControls() {
  const L = useLang();
  const setUi = useStore((s) => s.setUi);
  const sourceName = useStore((s) => s.recording.sourceName);
  const audioSource = useStore((s) => s.recording.audioSource);
  const setRecording = useStore((s) => s.setRecording);
  return (
    <div style={styles.idleBar}>
      <div style={styles.idleBarCard}>
        <button className="idc-btn" style={styles.chip} onClick={() => setUi({ settingsOpen: true })} title="F10 / Shift+F6">⏪ {L("重录", "Retake")}</button>
        <button className="idc-btn" style={styles.chip} onClick={() => setUi({ settingsOpen: true })} title="F6">🛡 {L("隐私遮挡", "Privacy mask")}</button>
        <button className="idc-btn" style={styles.chip} onClick={() => setUi({ settingsOpen: true })} title="F4">⏩ {L("快进压缩", "Fast-forward")}</button>
        <button className="idc-btn" style={styles.sourceChip} onClick={() => setUi({ sourcePickerOpen: true })} title={L("选择录制的屏幕或窗口", "Pick the screen or window to record")}>
          🖥 {L("画面源", "Source")}：{sourceName === "主显示器" || !sourceName ? L("主显示器", "Primary display") : sourceName} ▾
        </button>
        <button
          className="idc-btn"
          style={styles.sourceChip}
          onClick={() => {
            const order: Array<"system" | "mic" | "both"> = ["system", "mic", "both"];
            const next = order[(order.indexOf(audioSource) + 1) % order.length];
            setRecording({ audioSource: next });
            void import("../../lib/tauri").then((m) => m.tauriInvoke("set_audio_source", { source: next }).catch(() => {}));
          }}
          title={L("点击切换：系统声音 / 麦克风 / 全部", "Click to cycle: system audio / mic / both")}
        >
          {audioSource === "system" ? `🔊 ${L("系统声音", "System audio")}` : audioSource === "mic" ? `🎤 ${L("麦克风", "Microphone")}` : `🔊🎤 ${L("全部", "Both")}`} ▾
        </button>
      </div>
    </div>
  );
}

/** Centered splash overlay with grow-in (open) / shrink-toward-top-right
 *  (close) animation. Closing flies toward the top-right reopen button. */
function BannerOverlay(props: {
  bannerUrl: string;
  closeTargetRect: () => { x: number; y: number } | null;
  onClose: () => void;
}) {
  const { bannerUrl, closeTargetRect, onClose } = props;
  const innerRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);

  const close = () => {
    if (closing) return;
    const r = innerRef.current?.getBoundingClientRect();
    const t = closeTargetRect();
    if (r && t) setOffset({ x: t.x - (r.left + r.width / 2), y: t.y - (r.top + r.height / 2) });
    setClosing(true);
    window.setTimeout(onClose, 340);
  };

  return (
    <div style={styles.bannerLayer}>
      <div
        ref={innerRef}
        style={{
          ...styles.bannerCard,
          animation: "bannerGrow 320ms cubic-bezier(.2,.8,.3,1)",
          transition: closing ? "transform 340ms cubic-bezier(.55,.08,.66,.5), opacity 260ms ease" : "none",
          transform: closing && offset ? `translate(${offset.x}px, ${offset.y}px) scale(0.08)` : undefined,
          opacity: closing ? 0 : undefined,
        }}
      >
        <button
          style={styles.bannerClose}
          onClick={close}
          title="收起开屏图（右上角按钮可重新展开）"
        >✕</button>
        <img src={bannerUrl} style={styles.banner} alt="EaseRec" />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  stage: {
    flex: 1, position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
    background: "linear-gradient(180deg, var(--stage-from) 0%, var(--stage-to) 100%)",
    borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)",
    overflow: "hidden", minHeight: 160,
  },
  video: { width: "100%", height: "100%", objectFit: "contain" },
  ctaWrap: {
    position: "absolute", top: 10, left: 0, right: 0, zIndex: 6,
    display: "flex", justifyContent: "center", pointerEvents: "none",
  } as React.CSSProperties,
  ctaBar: {
    display: "flex", alignItems: "center", gap: 12, pointerEvents: "auto",
    padding: "9px 12px 9px 16px", borderRadius: "var(--radius-lg)",
    // SOLID card — it floats over a MOVING video; translucency + blur made
    // the text compete with the footage underneath.
    background: "var(--bg-secondary)",
    border: "1px solid var(--accent)",
    boxShadow: "0 10px 32px rgba(0,0,0,0.55), 0 0 16px var(--accent-glow)",
    animation: "slideIn 0.25s ease-out", whiteSpace: "nowrap",
  } as React.CSSProperties,
  ctaText: { fontSize: 13, fontWeight: 700, color: "var(--text-primary)" },
  ctaBtn: {
    fontSize: 12, fontWeight: 700, padding: "6px 14px", borderRadius: "var(--radius-sm)",
    background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer",
    boxShadow: "0 0 12px var(--accent-glow)", animation: "exportBreath 2s infinite",
  },
  ctaClose: {
    background: "none", border: "none", color: "var(--text-muted)",
    fontSize: 11, cursor: "pointer", padding: "0 2px",
  },
  badge: {
    position: "absolute", zIndex: 5, fontSize: 11, fontWeight: 700, color: "#fff",
    padding: "3px 10px", borderRadius: 10, background: "var(--badge-bg)",
    border: "1px solid var(--border-default)", display: "flex", alignItems: "center", gap: 6,
    fontFamily: "var(--font-mono)",
  },
  liveDot: { width: 7, height: 7, borderRadius: 4, background: "#fff", animation: "pulse 1.2s infinite" },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", gap: 13, padding: 20 },
  emptyHint: { fontSize: 13, color: "var(--text-muted)", textAlign: "center", maxWidth: 320, lineHeight: 1.5 },
  idleBar: {
    position: "absolute", left: 0, right: 0, bottom: 10, zIndex: 6,
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: "0 12px", pointerEvents: "none",
  } as React.CSSProperties,
  idleBarCard: {
    display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "center",
    padding: "7px 10px", borderRadius: "var(--radius-lg)",
    background: "var(--bg-glass)", border: "1px solid var(--border-default)",
    boxShadow: "0 6px 20px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.06)",
    backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
    pointerEvents: "none",
  } as React.CSSProperties,
  bannerLayer: {
    position: "absolute", inset: 0, zIndex: 4, pointerEvents: "none",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  bannerCard: {
    position: "relative", pointerEvents: "auto",
    borderRadius: "var(--radius-md)", overflow: "hidden",
    border: "1px solid var(--border-default)",
    boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
    maxWidth: "46%", lineHeight: 0, background: "var(--bg-primary)",
  },
  banner: { width: "100%", display: "block", borderRadius: "var(--radius-md)" },
  bannerClose: {
    position: "absolute", top: 6, right: 8, zIndex: 3,
    width: 22, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
    background: "rgba(10,12,18,0.6)", color: "#fff", fontSize: 11, lineHeight: 1,
  },
  bannerReopen: {
    position: "absolute", top: 10, right: 10, zIndex: 6,
    width: 30, height: 30, borderRadius: 15,
    background: "rgba(99,130,255,0.18)", color: "var(--accent)",
    border: "1px solid var(--border-accent)", cursor: "pointer",
    fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 2px 8px rgba(0,0,0,0.20)",
  },
  chip: {
    padding: "7px 14px", borderRadius: 16, fontSize: 12, fontWeight: 600,
    background: "var(--bg-tertiary)", color: "var(--text-primary)",
    border: "1px solid var(--border-default)", cursor: "pointer", pointerEvents: "auto",
    boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
  },
  sourceChip: {
    padding: "7px 14px", borderRadius: 16, fontSize: 12, fontWeight: 700,
    background: "var(--accent-glow)", color: "var(--accent)",
    border: "1px solid var(--border-accent)", cursor: "pointer", pointerEvents: "auto",
    boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
  },
};
