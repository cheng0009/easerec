/**
 * DirectorCam recorder — Electron-native live recording pipeline.
 *
 * This module runs entirely in the page (renderer) and uses the Web platform:
 *   - navigator.mediaDevices.getDisplayMedia() for the screen source
 *   - navigator.mediaDevices.getUserMedia() for webcam / mic
 *   - "loopback" audio via the display-media request handler (main process)
 *   - GPU canvas composition with a spring camera (smart follow + anti-shake)
 *   - MediaRecorder to produce a vp8/vp9 webm (hardware decoded screen stream)
 *
 * The Electron main process MUST call:
 *   setDisplayMediaRequestHandler(...) granting the requested screen source.
 */

import { SpringCamera } from "./SpringCamera";
import { SmartZoom } from "./SmartZoom";
import { useStore } from "../store";
import { dHash, hashToHex, type GrayFrame } from "../lib/perceptualHash";
import { clampScreenRectToSource } from "../lib/sourceMap";
import { webcamLayout } from "../lib/webcamLayout";
import type { MaskRegion } from "./edl";

function dcInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const g = globalThis as unknown as {
    __directorcam?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T> };
  };
  if (!g.__directorcam) return Promise.reject(new Error("bridge unavailable"));
  return g.__directorcam.invoke(cmd, args);
}

export interface SourceOption {
  id: string;
  name: string;
  kind: "screen" | "window";
}

export interface RecorderSettings {
  fps: number;
  resolution: { width: number; height: number };
  bitrateMbps: number;
  codec: "vp9" | "h264" | "h265" | "av1";
  audioSource: "system" | "mic" | "both";
  zoomEnabled: boolean;
  zoomLevel: number;
}

export interface RecorderHandlers {
  onPreview?: (img: ImageBitmap) => void;
  onRecordingState?: (recording: boolean) => void;
  onPerf?: (fps: number) => void;
  onElapsed?: (elapsedMs: number) => void;
  onSaved?: (path: string) => void;
  onError?: (message: string) => void;
}

export class Recorder {
  private settings: RecorderSettings;
  private handlers: RecorderHandlers;
  private spring: SpringCamera;
  private smart: SmartZoom;

  private screenStream: MediaStream | null = null;
  private webcamStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;

  /** Anchor <video> element playing the screen stream (source for canvas). */
  private screenVideo: HTMLVideoElement | null = null;
  /** Webcam <video> element for overlay drawing. */
  private webcamVideo: HTMLVideoElement | null = null;

  private compositeCanvas: HTMLCanvasElement | null = null;
  private recorder: MediaRecorder | null = null;
  /** Collected MediaRecorder data chunks for the current session. */
  private chunks: Blob[] = [];

  private recording = false;
  private previewRaf: number | null = null;
  private lastPreviewAt = 0;

  // --- Streaming session (incremental disk flush) ---------------------------
  /** True while the main process holds an open recording session for us. */
  private sessionActive = false;
  /** Ordered flush chain: MediaRecorder chunks must reach disk in order. */
  private chunkChain: Promise<void> = Promise.resolve();
  /** Set after a clean session end — the file the main process wrote. */
  private streamedPath: string | null = null;
  /** Recording wall-clock start (Date.now at MediaRecorder.start). */
  private recStartWallMs = 0;
  /** Last onElapsed emission (throttle for the UI clock feed). */
  private lastElapsedEmitAt = 0;

  // --- Fast-forward mode ----------------------------------------------------
  private ffMode = false;
  private audioTrackRefs: MediaStreamTrack[] = [];
  // --- Audio mixing (loopback + mic -> single recorded track) ---------------
  /** WebAudio graph that merges system + mic into ONE track (Chrome's WebM
   *  muxer only records a single audio track, so "both" must be pre-mixed or
   *  the second source is silently dropped). Null when not mixing. */
  private audioMixer: {
    ctx: AudioContext;
    sources: MediaStreamAudioSourceNode[];
    recordTrack: MediaStreamTrack;
  } | null = null;

  /** 30ms recording tick: mouse sampling + (webcam mode) canvas painting.
   *  Runs while minimized — rAF does not, which used to freeze recordings. */
  private recTickTimer: ReturnType<typeof setInterval> | null = null;
  private loopbackStream: MediaStream | null = null;
  /** True while MediaRecorder captures the RAW capture track (no canvas). */
  private recordingRawVideo = false;

  /** Is this recording bypassing the composite canvas? (preview-only info) */
  get isRawRecording(): boolean {
    return this.recordingRawVideo;
  }

  // --- Mouse-track logging (export-time follow-focus source data) ----------
  // "录轨迹，导出渲染": recording keeps a 1:1 frame; only the cursor path is
  // logged here (~30ms cadence) and flushed to the mouse sidecar, so the
  // follow-focus motion costs NOTHING while recording and is rendered by
  // ffmpeg (zoompan) at export.
  private mouseSamples: { tMs: number; x: number; y: number }[] = [];
  private lastMouseSampleAt = 0;

  // --- Capture source -------------------------------------------------------
  /** Currently granted capture source id ("screen:x:y" / "window:hwnd:n"). */
  private currentSourceId: string | null = null;
  /** On-screen DIP rect of the captured source (primary-origin), from main. */
  private captureRect: { x: number; y: number; w: number; h: number } | null = null;

  /** Latest cursor pos normalized to source space (0-1). Set via dc-cursor. */
  private cursorNorm = { x: 0.5, y: 0.5 };
  /** Latest cursor in OS screen DIP coords (primary-origin). */
  private cursorScreen = { x: 0, y: 0 };
  /** Cached smart-follow target (normalized source space). */
  private followTarget = { x: 0.5, y: 0.5 };
  private lastCamTime = 0;

  /**
   * When true the visible desktop overlay (always-on-top transparent window)
   * is the single source of annotation effects and they are being captured with
   * the screen, so compose() must NOT also draw them into the recording canvas.
   */
  private desktopOverlayActive = false;

  /** Enable/disable "desktop overlay is the single effect source" mode. */
  setDesktopOverlayActive(v: boolean): void {
    this.desktopOverlayActive = v;
  }
  get overlayActive(): boolean {
    return this.desktopOverlayActive;
  }

  /** Public access to the captured source pixel size. */
  get sourceSizePublic(): { width: number; height: number } {
    return { ...this.sourceSize };
  }

  /** Cursor in OS screen DIP coordinates (for the desktop overlay). */
  get cursorScreenPublic(): { x: number; y: number } {
    return { ...this.cursorScreen };
  }

  private sourceSize = { width: 1920, height: 1080 };
  private webcamSize = { width: 640, height: 480 };

  constructor(
    settings: Partial<RecorderSettings>,
    handlers: RecorderHandlers = {},
  ) {
    this.settings = {
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      bitrateMbps: 20,
      codec: "vp9",
      audioSource: "both",
      // The camera SIMULATION always runs (it drives the live focus preview
      // box and matches the export render); it never touches recorded pixels.
      zoomEnabled: true,
      zoomLevel: 1.5,
      ...settings,
    };
    this.handlers = handlers;
    this.spring = new SpringCamera();
    this.smart = new SmartZoom({
      enabled: this.settings.zoomEnabled,
      zoomLevel: this.settings.zoomLevel,
    });
  }

  /**
   * Fetch the live screen stream. Requires Electron main to grant display media.
   * `sourceId` selects a specific screen/window ("screen:x:y"/"window:hwnd:n");
   * `null` clears the pick so main falls back to the primary screen; undefined
   * leaves the current pick untouched. Returns a `live` flag and the anchor
   * video element already attached.
   */
  async startScreen(sourceId?: string | null): Promise<boolean> {
    if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
      this.handlers.onError?.("Screen capture is not supported in this environment.");
      return false;
    }
    try {
      if (sourceId !== undefined) {
        try { await dcInvoke("set_capture_source", { sourceId: sourceId ?? null }); } catch { /* fallback below */ }
      }
      const res = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "no-preference" },
        audio: false,
      } as MediaStreamConstraints);
      if (this.screenStream) this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = res;
      if (sourceId !== undefined) this.currentSourceId = sourceId;
      const videoTrack = res.getVideoTracks()[0];
      const s = videoTrack.getSettings();
      if (s.width && s.height) this.sourceSize = { width: s.width, height: s.height };
      // Scale the follow thresholds with the capture size (4K flicks are not
      // teleports — see replayCamera for the export-side equivalent).
      this.smart.updateConfig({
        teleportPx: Math.max(900, this.sourceSize.width * 0.55),
        deadZonePx: 2.5 * Math.max(1, this.sourceSize.width / 1920),
      });
      if (sourceId) await this.refreshCaptureRect();
      else if (sourceId === null) this.captureRect = null; // primary screen: full-frame masks

      const video = document.createElement("video");
      video.srcObject = res;
      video.muted = true;
      this.screenVideo = video;
      await video.play().catch(() => {});
      console.log(
        `[Recorder] capture settings=${JSON.stringify(s)} ` +
        `videoWxH=${video.videoWidth}x${video.videoHeight} ` +
        `screen=${window.screen.width}x${window.screen.height} dpr=${window.devicePixelRatio}`,
      );

      // Set up the composed preview canvas and start a continuous render loop
      // so live preview matches the recorded output (zoom / effects visible).
      this.ensureCompositeCanvas();
      this.startPreviewLoop();
      return true;
    } catch (e) {
      const detail = String((e as Error | null)?.message ?? e);
      let zh: boolean;
      try { zh = (localStorage.getItem("directorcam_lang") ?? "zh-CN") !== "en"; } catch { zh = true; }
      this.handlers.onError?.(zh
        ? `⚠ 无法采集该画面源（${detail}）——窗口可能已关闭/最小化，或被系统保护`
        : `⚠ Cannot capture this source (${detail}) — the window may be closed, minimized, or system-protected`);
      return false;
    }
  }

  /** Restart the capture with a different screen/window source; `null`
   *  returns to the primary screen. */
  async switchSource(sourceId: string | null): Promise<boolean> {
    const ok = await this.startScreen(sourceId);
    if (ok && sourceId !== undefined) this.currentSourceId = sourceId;
    return ok;
  }

  get activeSourceId(): string | null {
    return this.currentSourceId;
  }

  /** Fetch the captured source's on-screen DIP rect from the main process. */
  private async refreshCaptureRect(): Promise<void> {
    try {
      const rect = await dcInvoke<{ x: number; y: number; w: number; h: number } | null>("get_source_rect", { sourceId: this.currentSourceId });
      this.captureRect = rect ?? null;
    } catch { this.captureRect = null; }
  }

  /**
   * Apply user recording settings (fps/resolution/bitrate). Takes effect on
   * the next startRecording (the composite canvas is sized there).
   */
  applySettings(s: { fps: number; resolution: { width: number; height: number }; bitrateMbps: number }): void {
    this.settings = {
      ...this.settings,
      fps: Math.max(1, Math.min(120, Math.round(s.fps || this.settings.fps))),
      resolution: s.resolution,
      bitrateMbps: Math.max(1, Math.min(160, s.bitrateMbps || this.settings.bitrateMbps)),
    };
  }

  /** Create (or size) the composed recording/preview canvas. */
  private ensureCompositeCanvas(): HTMLCanvasElement {
    if (!this.compositeCanvas) {
      const cc = document.getElementById("recording-canvas") as HTMLCanvasElement | null
        ?? document.createElement("canvas");
      cc.id = "recording-canvas";
      cc.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;";
      if (!document.contains(cc)) document.body.appendChild(cc);
      this.compositeCanvas = cc;
    }
    const cw = this.settings.resolution.width;
    const ch = this.settings.resolution.height;
    if (this.compositeCanvas.width !== cw) this.compositeCanvas.width = cw;
    if (this.compositeCanvas.height !== ch) this.compositeCanvas.height = ch;
    return this.compositeCanvas;
  }

  private previewLoopRunning = false;
  private startPreviewLoop(): void {
    if (this.previewLoopRunning) return;
    this.previewLoopRunning = true;
    const tick = () => {
      if (!this.previewLoopRunning) return;
      // Compose whenever ANY visual source exists: the webcam PiP must be
      // visible in the preview even before a screen capture is granted.
      if (this.screenVideo || this.webcamVideo) this.compose();
      this.previewRaf = requestAnimationFrame(tick);
    };
    tick();
  }
  private stopPreviewLoop(): void {
    this.previewLoopRunning = false;
    if (this.previewRaf !== null) { cancelAnimationFrame(this.previewRaf); this.previewRaf = null; }
  }

  async startWebcam(): Promise<boolean> {
    if (typeof navigator.mediaDevices?.getUserMedia !== "function") return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const t = stream.getVideoTracks()[0];
      const s = t.getSettings();
      if (s.width && s.height) this.webcamSize = { width: s.width, height: s.height };
      this.webcamStream = stream;
      this.webcamVideo = document.createElement("video");
      this.webcamVideo.srcObject = stream;
      this.webcamVideo.muted = true;
      await this.webcamVideo.play().catch(() => {});
      // Make the PiP visible immediately: ensure the composite canvas exists
      // and the preview loop runs even without a screen capture yet.
      this.ensureCompositeCanvas();
      this.startPreviewLoop();
      return true;
    } catch {
      return false;
    }
  }

  async stopWebcam(): Promise<void> {
    this.webcamStream?.getVideoTracks().forEach((t) => t.stop());
    this.webcamStream = null;
    this.webcamVideo = null;
  }

  async startMic(): Promise<boolean> {
    if (typeof navigator.mediaDevices?.getUserMedia !== "function") return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.micStream = stream;
      return stream.getAudioTracks().length > 0;
    } catch {
      return false;
    }
  }

  /** Merge several audio tracks into ONE track (Chrome's webm muxer keeps a
   *  single audio track; `both` needs system + mic combined beforehand).
   *  The sources are left running — FF-mute and the WebAudio graph both read
   *  the raw tracks, so `track.enabled` keeps working as the mute switch. */
  private mixAudioTracks(tracks: MediaStreamTrack[]): NonNullable<Recorder["audioMixer"]> {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    void ctx.resume();
    // Force 2ch output: system audio is usually stereo, mic mono; the muxer
    // would otherwise pick whichever channel layout comes first.
    const dest = ctx.createMediaStreamDestination();
    const sources = tracks.map((t) => {
      const src = ctx.createMediaStreamSource(new MediaStream([t]));
      src.connect(dest);
      return src;
    });
    const recordTrack = dest.stream.getAudioTracks()[0];
    if (!recordTrack) {
      // Extremely defensive: if the destination produced no track, fall back
      // to the first raw input rather than recording silence.
      sources.forEach((s) => s.disconnect());
      void ctx.close();
      return { ctx, sources: [], recordTrack: tracks[0] };
    }
    return { ctx, sources, recordTrack };
  }

  setCursorPosition(x: number, y: number): void {
    if (!this.spring || !this.smart) return;
    // x/y come from the OS as DIP coordinates (screen.getCursorScreenPoint).
    // Convert them to source-pixel space first so the normalized cursor stays
    // consistent with the captured stream size even on scaled displays (where
    // DIP != physical pixels).
    const SW = Math.max(1, this.sourceSize.width);
    const SH = Math.max(1, this.sourceSize.height);
    const dispW = Math.max(1, window.screen?.width || SW);
    const dispH = Math.max(1, window.screen?.height || SH);
    const srcX = (x / dispW) * SW;
    const srcY = (y / dispH) * SH;
    // Keep a normalized cursor for effect rendering / markers.
    this.cursorNorm = {
      x: Math.max(0, Math.min(1, srcX / SW)),
      y: Math.max(0, Math.min(1, srcY / SH)),
    };
    this.cursorScreen = { x, y };

    const target = this.smart.process({ x: srcX, y: srcY }, { width: SW, height: SH });
    if (target) this.followTarget = target;
  }

  /** Normalized cursor in the output (0-1 of canvas). */
  get cursorOutput(): { x: number; y: number } {
    return { ...this.cursorNorm };
  }

  /**
   * Start a recording session drawing onto `compositionCanvas`.
   */
  async startRecording(compositionCanvas?: HTMLCanvasElement | null): Promise<void> {
    if (!this.screenVideo) {
      const ok = await this.startScreen();
      if (!ok) throw new Error("No screen stream available.");
    }

    // Create an off-DOM recording canvas if none was supplied. This lets
    // recording start via global hotkeys or the UI without requiring a
    // pre-existing element with id "recording-canvas".
    if (!compositionCanvas) {
      const cc = document.createElement("canvas");
      cc.id = "recording-canvas";
      // Keep it in the DOM and painted (opacity:0) so captureStream keeps
      // producing frames; an off-viewport position can stop repaints.
      cc.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;";
      document.body.appendChild(cc);
      compositionCanvas = cc;
    }

    const cw = this.settings.resolution.width;
    const ch = this.settings.resolution.height;
    this.compositeCanvas = compositionCanvas;
    compositionCanvas.width = cw;
    compositionCanvas.height = ch;

    // A hidden <video> is the source we read pixels from.
    const canvasStream = compositionCanvas.captureStream(this.settings.fps);
    if (!canvasStream) throw new Error("Canvas capture unsupported in this Chromium build.");

    const audioTracks: MediaStreamTrack[] = [];
    const wantSystem = this.settings.audioSource === "system" || this.settings.audioSource === "both";
    const wantMic = this.settings.audioSource === "mic" || this.settings.audioSource === "both";

    // Screen + loopback audio in ONE getDisplayMedia call. The loopback VIDEO
    // track is kept: when the webcam is off we record it RAW (no canvas in
    // the hot path — Recordly-style; this is what keeps recordings smooth).
    this.loopbackStream = null;
    this.recordingRawVideo = false;
    if (wantSystem) {
      if (!this.loopbackStream) {
        try {
          this.loopbackStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
          } as MediaStreamConstraints);
        } catch { /* loopback may be denied */ }
      }
      const at = this.loopbackStream?.getAudioTracks()[0];
      if (at) audioTracks.push(at);
    }
    if (wantMic) {
      if (!this.micStream) await this.startMic();
      const at = this.micStream?.getAudioTracks()[0];
      if (at) audioTracks.push(at);
    }

    // Chrome's MediaRecorder only muxes ONE audio track into the webm. When
    // "both" is selected, both system loopback + mic arrive as separate tracks
    // — without pre-mixing, the second one is silently lost and the export is
    // half-silent. Merge them into a single track via Web Audio.
    if (audioTracks.length > 1) {
      this.audioMixer = this.mixAudioTracks(audioTracks);
      const mixed = this.audioMixer.recordTrack;
      // Keep the RAW tracks for FF-mute; recording uses the mixed track.
      this.audioTrackRefs = audioTracks;
      audioTracks.splice(0, audioTracks.length, mixed);
    } else {
      this.audioMixer = null;
      this.audioTrackRefs = audioTracks;
    }

    // Video source: raw capture track unless the webcam PiP must be baked in.
    let videoTracks: MediaStreamTrack[];
    const webcamActive = !!(this.webcamVideo && useStore.getState().webcam.enabled);
    const rawVideo = this.loopbackStream?.getVideoTracks()[0];
    if (webcamActive || !rawVideo) {
      videoTracks = canvasStream.getVideoTracks();
    } else {
      videoTracks = [rawVideo];
      this.recordingRawVideo = true;
    }

    const recordStream = new MediaStream([...videoTracks, ...audioTracks]);

    // Open the main-process session BEFORE the first chunk can arrive so the
    // EBML header lands in a fresh file (incremental disk flush).
    this.streamedPath = null;
    this.sessionActive = false;
    // Every session starts un-cropped: a region from a PREVIOUS recording
    // must not leak into this one via recording_end (stale sidecar).
    this.sessionRegion = null;
    try {
      const begin = await dcInvoke<{ lowDisk?: boolean; freeGb?: number }>("recording_begin");
      this.sessionActive = true;
      if (begin?.lowDisk) {
        const zh = (() => { try { return (localStorage.getItem("directorcam_lang") ?? "zh-CN") !== "en"; } catch { return true; } })();
        useStore.getState().setMarks({
          feedback: zh
            ? `⚠ 磁盘空间不足（剩 ${(begin.freeGb ?? 0).toFixed(1)} GB），长录制可能失败`
            : `⚠ Low disk (${(begin.freeGb ?? 0).toFixed(1)} GB left) — long recordings may fail`,
        });
      }
    } catch (e) {
      console.warn("[Recorder] streaming session unavailable, falling back to in-memory chunks:", e);
    }

    // Prefer H.264 in WebM: it maps to the platform hardware encoder, which
    // keeps 1080p/4K realtime recording cheap (software VP9 starved the CPU
    // and produced dropped/jerky frames).
    const mimeCandidates = [
      "video/webm;codecs=h264",
      "video/webm;codecs=vp9",
      "video/webm",
    ];
    const mime = mimeCandidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "video/webm";
    this.recorder = new MediaRecorder(recordStream, {
      mimeType: mime,
      videoBitsPerSecond: this.settings.bitrateMbps * 1_000_000,
      audioBitsPerSecond: 192_000,
    });

    this.recorder.start(1000);
    this.recStartWallMs = Date.now();
    // Register dataavailable IMMEDIATELY so the initial (EBML-header) chunk
    // produced right after start() is captured. Registering it later in
    // stopRecording() would drop that chunk and produce a corrupt webm.
    const rec = this.recorder;
    rec.addEventListener("dataavailable", (e: Event) => {
      const d = (e as unknown as { data?: Blob }).data;
      if (!d || d.size === 0) return;
      if (this.sessionActive) {
        // Stream to disk preserving chunk order (each link awaits the last).
        this.chunkChain = this.chunkChain.then(async () => {
          const bytes = new Uint8Array(await d.arrayBuffer());
          await dcInvoke("recording_chunk", { bytes });
        }).catch((err) => console.warn("[Recorder] chunk flush failed:", err));
      } else {
        this.chunks.push(d);
      }
    });
    this.recording = true;
    this.mouseSamples = [];
    this.lastMouseSampleAt = 0;
    this.lastPreviewAt = 0;
    this.lastElapsedEmitAt = 0;
    // The 30ms recording tick replaces rAF while the app is minimized
    // (rAF stops firing for hidden windows; timers with
    // backgroundThrottling:false do not). It samples the mouse trajectory
    // and, in webcam mode, keeps painting the composite canvas.
    if (this.recTickTimer) clearInterval(this.recTickTimer);
    this.recTickTimer = setInterval(() => {
      if (!this.recording) return;
      this.sampleMouseTrack();
      // UI elapsed clock (LIVE badge, film strip). Throttled far below the
      // 30ms sampling cadence — the store update re-renders the studio.
      if (Date.now() - this.lastElapsedEmitAt >= 500) {
        this.lastElapsedEmitAt = Date.now();
        this.handlers.onElapsed?.(Date.now() - this.recStartWallMs);
      }
    }, 30);
    // Preview painter: rAF is fine here (the PREVIEW may freeze while
    // minimized — only the RECORDING matters then). In raw mode this paints
    // the raw capture + webcam PiP so the on-screen preview stays WYSIWYG.
    if (this.previewRaf === null) this.startPreviewLoop();
    this.handlers.onRecordingState?.(true);
  }

  /** Mouse-trajectory sampling: movement points + 400ms dwell markers, so
   *  the export replay holds the camera still instead of drifting. */
  private sampleMouseTrack(): void {
    if (!this.sessionActive) return;
    const nowMs = performance.now();
    if (nowMs - this.lastMouseSampleAt < 30) return;
    this.lastMouseSampleAt = nowMs;
    const tMs = this.getElapsedMs();
    const last = this.mouseSamples[this.mouseSamples.length - 1];
    if (!last) {
      this.mouseSamples.push({ tMs, x: this.cursorNorm.x, y: this.cursorNorm.y });
      return;
    }
    const moved = last.x !== this.cursorNorm.x || last.y !== this.cursorNorm.y;
    const dwellGap = tMs - last.tMs >= 400;
    if (moved || dwellGap) {
      this.mouseSamples.push({ tMs, x: this.cursorNorm.x, y: this.cursorNorm.y });
    }
    if (this.mouseSamples.length >= 200) {
      const batch = this.mouseSamples.splice(0, this.mouseSamples.length);
      void dcInvoke("recording_mousesamples", { samples: batch }).catch(() => {});
    }
  }

  /** Selected record region (normalized primary-screen) for this session. */
  private sessionRegion: { x: number; y: number; w: number; h: number } | null = null;

  /** Set the session's record region (called right after beginRecording). */
  async setSessionRegion(rect: { x: number; y: number; w: number; h: number }): Promise<void> {
    this.sessionRegion = rect;
    await dcInvoke("recording_set_region", { rect });
  }

  /**
   * Region-recording selection: shows the overlay box-select UI and resolves
   * with the normalized rect (primary-screen space), or null on cancel.
   */
  async selectRegionOnOverlay(): Promise<{ x: number; y: number; w: number; h: number } | null> {
    return dcInvoke<{ x: number; y: number; w: number; h: number } | null>(
      "region_select_session",
      {},
    );
  }

  /** Cancel a pending overlay region selection (second press while dragging). */
  async cancelRegionSelection(): Promise<void> {
    try { await dcInvoke("region_select_cancel", {}); } catch { /* nothing pending */ }
  }

  /** Source-recording clock (ms since MediaRecorder.start). */
  getElapsedMs(): number {
    return this.recording && this.recStartWallMs ? Date.now() - this.recStartWallMs : 0;
  }

  /** Fast-forward mode: mute the recorded audio, freeze the spring camera and
   *  show the overlay banner. Marks still come from marks.ts. */
  setFFMode(on: boolean): void {
    if (this.ffMode === on) return;
    this.ffMode = on;
    for (const t of this.audioTrackRefs) {
      try { t.enabled = !on; } catch { /* ignore */ }
    }
    void dcInvoke("overlay_ff", { on }).catch(() => {});
  }

  get isFFMode(): boolean {
    return this.ffMode;
  }

  /**
   * Map an overlay-drawn rect (primary-screen normalized) into the captured
   * frame's normalized space, CLAMPING any overhang into the source: a box
   * that partly hangs outside a window/display still masks the capturable
   * part, so it no longer silently rejects and vanishes. Null only when there
   * is NO overlap at all (the box is on another display / fully outside).
   * `clipped` reports whether the box was shrunk from the drawn shape.
   */
  mapPrivacyRegion(rect: MaskRegion): { rect: MaskRegion; clipped: boolean } | null {
    const screenW = Math.max(1, window.screen?.width || 1);
    const screenH = Math.max(1, window.screen?.height || 1);
    const src = this.captureRect ?? { x: 0, y: 0, w: screenW, h: screenH };
    const clamped = clampScreenRectToSource(rect, src, screenW, screenH);
    if (!clamped) return null;
    const drawn = Math.max(1, rect.w * screenW * rect.h * screenH);
    const kept = clamped.w * src.w * clamped.h * src.h;
    return { rect: clamped, clipped: kept / drawn < 0.98 };
  }

  /** Convert a source-normalized region back to primary-screen normalized
   *  coords, so the overlay can keep the mosaic on the same pixels that the
   *  export will mask (used after clamping). */
  mapSourceToScreenRegion(region: MaskRegion): MaskRegion {
    const screenW = Math.max(1, window.screen?.width || 1);
    const screenH = Math.max(1, window.screen?.height || 1);
    const src = this.captureRect ?? { x: 0, y: 0, w: screenW, h: screenH };
    return {
      x: (src.x + region.x * src.w) / screenW,
      y: (src.y + region.y * src.h) / screenH,
      w: (region.w * src.w) / screenW,
      h: (region.h * src.h) / screenH,
    };
  }

  /**
   * Sample the privacy-mask reference from the RAW screen frame (NOT the
   * composite canvas — the camera zoom would shift the region). `region` is
   * already mapped into source-normalized space. Returns hex dHashes for the
   * masked region and the full page context, plus the 16x16 grayscale region
   * pixels (hex) used by the export-time occurrence scan as a cross-correlation
   * verification template.
   */
  samplePrivacyReference(region: MaskRegion): { region: string; frame: string; pixels: string } {
    const video = this.screenVideo;
    if (!video || !video.videoWidth) throw new Error("no screen frame");
    const grab = (rect: MaskRegion, size: number): GrayFrame => {
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      const sx = rect.x * video.videoWidth;
      const sy = rect.y * video.videoHeight;
      const sw = Math.max(1, rect.w * video.videoWidth);
      const sh = Math.max(1, rect.h * video.videoHeight);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, size, size);
      const img = ctx.getImageData(0, 0, size, size).data;
      const gray = new Uint8Array(size * size);
      for (let i = 0; i < gray.length; i++) {
        gray[i] = (img[i * 4] * 299 + img[i * 4 + 1] * 587 + img[i * 4 + 2] * 114) / 1000;
      }
      return { data: gray, width: size, height: size };
    };
    const hex = (g: GrayFrame): string => {
      let out = "";
      for (let i = 0; i < g.data.length; i++) out += g.data[i].toString(16).padStart(2, "0");
      return out;
    };
    const regionHash = dHash(grab(region, 64), 8);
    const frameHash = dHash(grab({ x: 0, y: 0, w: 1, h: 1 }, 32), 8);
    return {
      region: hashToHex(regionHash),
      frame: hashToHex(frameHash),
      pixels: hex(grab(region, 16)),
    };
  }

  /** The path written by the main-process streaming session (after stop). */
  consumeStreamedPath(): string | null {
    const p = this.streamedPath;
    this.streamedPath = null;
    return p;
  }

  /** Draw one composed frame onto the canvas (follow zoom + effects + webcam). */
  private compose(): void {
    const src = this.screenVideo;
    const canvas = this.compositeCanvas;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const SW = this.sourceSize.width;
    const SH = this.sourceSize.height;
    const OW = canvas.width;
    const OH = canvas.height;
    if (OW <= 0 || OH <= 0) return;

    // Webcam-only mode (screen capture not granted yet): flat stage + PiP.
    if (!src) {
      ctx.fillStyle = "#16130f";
      ctx.fillRect(0, 0, OW, OH);
      this.drawWebcamPiP(ctx, OW, OH);
      this.emitPreview();
      return;
    }
    if (SW <= 0 || SH <= 0) return;

    // --- Camera: whole-frame follow zoom (only while no annotation overlay is
    // --- shown on the real desktop; that overlay is captured with the screen). ---
    const now = performance.now();
    const dtMs = this.lastCamTime ? Math.min(now - this.lastCamTime, 40) : 16.7;
    this.lastCamTime = now;

    // Fast-forward freezes the camera just like the desktop overlay does: the
    // compressed section must not wobble after the export speed-up.
    const overlayOn = this.desktopOverlayActive || this.ffMode;
    const eff = useStore.getState().effects;
    if (overlayOn) {
      // The desktop overlay is the single annotation source: keep the canvas as
      // a neutral full-frame copy so the captured stream + overlay stay aligned
      // (the whole-frame follow-zoom stays off while effects are shown).
      this.spring.update(0.5, 0.5, dtMs);
      this.spring.updateScale(1.0, dtMs);
      this.smart.setCurrentZoom(1.0);
    } else {
      const tracking = this.smart.tracking;
      if (tracking) {
        this.spring.update(this.followTarget.x, this.followTarget.y, dtMs);
      } else {
        this.spring.update(0.5, 0.5, dtMs);
      }
      this.spring.updateScale(tracking ? this.smart.config.zoomLevel : 1.0, dtMs);
      this.smart.setCurrentZoom(this.spring.state.scale);
    }

    // The spring camera KEEPS simulating (it drives the live focus preview
    // box and matches what export renders) but is NO LONGER applied to the
    // recorded pixels — the follow/zoom is rendered by ffmpeg at export.
    // Draw the FULL source, letterboxed:
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, OW, OH);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Visible source window (keeps the canvas aspect, so no distortion).
    const A = OH / OW; // canvas aspect (height/width)
    let vw = Math.min(SW, SH / A); // window width in source px
    let vh = vw * A;
    if (vh > SH) { vh = SH; vw = vh / A; }
    const vx = (SW - vw) * 0.5;
    const vy = (SH - vh) * 0.5;

    ctx.drawImage(src, vx, vy, vw, vh, 0, 0, OW, OH);
    ctx.restore();

    // Store the source->canvas mapping for effects / markers.
    this.viewCtx = { vx, vy, vw, vh };

    const toCanvasX = (sx: number) => ((sx - vx) / vw) * OW;
    const toCanvasY = (sy: number) => ((sy - vy) / vh) * OH;

    // Webcam overlay (user-configured position/size/shape/border).
    this.drawWebcamPiP(ctx, OW, OH);

    // Step markers / highlighter / magnifier are baked into the recording here.
    // While the desktop overlay is active it is captured with the screen (it is
    // the visual annotation source), so the canvas stays neutral to avoid
    // double-drawing the effects.
    if (!overlayOn) {
      if (eff.stepMarkers.length > 0) {
      for (let i = 0; i < eff.stepMarkers.length; i++) {
        const m = eff.stepMarkers[i];
        const cx = toCanvasX(m.x * SW);
        const cy = toCanvasY(m.y * SH);        // Connection line to previous marker.
        if (i > 0) {
          const pm = eff.stepMarkers[i - 1];
          const px = toCanvasX(pm.x * SW);
          const py = toCanvasY(pm.y * SH);
          ctx.strokeStyle = "rgba(64,128,255,0.45)";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(cx, cy);
          ctx.stroke();
        }
        if (cx >= -60 && cx <= OW + 60 && cy >= -60 && cy <= OH + 60) {
          const r = Math.round(Math.max(16, OW * 0.018));
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(64,128,255,0.92)";
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.fillStyle = "#fff";
          ctx.font = `bold ${Math.round(r * 1.25)}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(i + 1), cx, cy + 1);
          ctx.restore();
        }
      }
    }

    // Highlighter ring that follows the cursor.
    if (eff.activeHighlighter) {
      this.drawHighlighterRing(ctx, OW, OH);
    }

    // Round magnifier lens (dark vignette + magnified circle at cursor).
      if (eff.activeMagnifier) {
        this.drawMagnifierLens(ctx, src, OW, OH, SW, SH);
      }
    }

    this.emitPreview();
  }

  /** Webcam picture-in-picture at the user-configured position/size/shape. */
  private drawWebcamPiP(ctx: CanvasRenderingContext2D, OW: number, OH: number): void {
    if (!this.webcamVideo || this.webcamVideo.readyState < 2) return;
    const cw = useStore.getState().webcam;
    const L = webcamLayout(OW, OH, cw, this.webcamSize.width / Math.max(1, this.webcamSize.height));
    const vw = this.webcamVideo.videoWidth || 1;
    const vh = this.webcamVideo.videoHeight || 1;
    const cx = L.x + L.w / 2;
    const cy = L.y + L.h / 2;
    ctx.save();
    ctx.beginPath();
    if (L.circle) {
      // TRUE circle (the layout box keeps the camera aspect, so the ellipse
      // clipped the wrong shape — a round PiP must be a circle with the
      // stream cover-cropped to fill it, not squished to the box).
      const r = Math.min(L.w, L.h) / 2;
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      const aspect = vw / vh;
      let dw = r * 2, dh = r * 2;
      if (aspect > 1) { dh = r * 2; dw = r * 2 * aspect; }
      else { dw = r * 2; dh = (r * 2) / aspect; }
      ctx.drawImage(this.webcamVideo, cx - dw / 2, cy - dh / 2, dw, dh);
    } else {
      ctx.roundRect(L.x, L.y, L.w, L.h, L.radius);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(this.webcamVideo, L.x, L.y, L.w, L.h);
    }
    ctx.restore();
    if (L.border.width > 0) {
      ctx.strokeStyle = L.border.color;
      ctx.lineWidth = L.border.width;
      ctx.beginPath();
      if (L.circle) {
        ctx.arc(cx, cy, Math.min(L.w, L.h) / 2, 0, Math.PI * 2);
      } else {
        ctx.roundRect(L.x, L.y, L.w, L.h, L.radius);
      }
      ctx.stroke();
    }
  }

  private viewCtx = { vx: 0, vy: 0, vw: 1, vh: 1 };

  /** Canvas coords (pixels) of the cursor, or null when outside the view. */
  private cursorCanvasPos(OW: number, OH: number): { cx: number; cy: number } | null {
    const { vx, vy, vw, vh } = this.viewCtx;
    const cx = ((this.cursorNorm.x * this.sourceSize.width - vx) / vw) * OW;
    const cy = ((this.cursorNorm.y * this.sourceSize.height - vy) / vh) * OH;
    if (cx < -OW * 0.3 || cx > OW * 1.3 || cy < -OH * 0.3 || cy > OH * 1.3) return null;
    return { cx: Math.max(0, Math.min(OW, cx)), cy: Math.max(0, Math.min(OH, cy)) };
  }

  /** Translucent yellow "荧光笔" ring / glow that follows the cursor. */
  private drawHighlighterRing(ctx: CanvasRenderingContext2D, OW: number, OH: number): void {
    const p = this.cursorCanvasPos(OW, OH);
    if (!p) return;
    const R = Math.max(30, Math.min(OW, OH) * 0.06);
    const { cx, cy } = p;
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 2.2);
    grad.addColorStop(0, "rgba(255,220,60,0.34)");
    grad.addColorStop(1, "rgba(255,220,60,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, OW, OH);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,210,40,0.9)";
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,210,40,0.9)";
    ctx.fill();
    ctx.restore();
  }

  /** Round magnifier lens: dims the frame and shows a magnified circle at cursor. */
  private drawMagnifierLens(
    ctx: CanvasRenderingContext2D,
    src: HTMLVideoElement,
    OW: number,
    OH: number,
    SW: number,
    SH: number,
  ): void {
    const p = this.cursorCanvasPos(OW, OH);
    if (!p) return;
    // Magnification + lens-hole size mirror the desktop overlay's 1/2/3 ladder
    // (overlaySync: magnifies 2.0/3.0/4.5, glass 0.16/0.26/0.36 of min dimension)
    // so the baked lens matches what the overlay shows on screen.
    const lvl = Math.min(3, Math.max(1, useStore.getState().effects.lensLevel ?? 2));
    const R = Math.max(60, Math.min(OW, OH) * (0.16 + (lvl - 1) * 0.10));
    const { cx, cy } = p;
    const M = 2.0 * Math.pow(1.5, lvl - 1);

    // The source point currently under the lens center.
    const srcCX = Math.max(0, Math.min(SW, this.cursorNorm.x * SW));
    const srcCY = Math.max(0, Math.min(SH, this.cursorNorm.y * SH));

    // Source px per canvas px (window keeps canvas aspect, so equal on both axes).
    const sppx = this.viewCtx.vw / OW;
    // Half-extent of the (square) source region magnified into the lens.
    const rad = (R / M) * sppx;
    const sW = Math.max(1, Math.min(SW, rad * 2));
    const sH = Math.max(1, Math.min(SH, rad * 2));
    const clipX = Math.max(0, Math.min(SW - sW, srcCX - sW / 2));
    const clipY = Math.max(0, Math.min(SH - sH, srcCY - sH / 2));

    // Dim the whole frame, then redraw only inside the lens circle magnified.
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, 0, OW, OH);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, clipX, clipY, sW, sH, cx - R, cy - R, R * 2, R * 2);
    ctx.restore();

    // Lens border + center dot.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fill();
    ctx.restore();
  }

  private emitPreview(): void {
    const now = Date.now();
    this.frameCount++;
    if (now - this.lastPreviewAt < 120 || !this.compositeCanvas) return;
    this.lastPreviewAt = now;

    const { onPreview, onPerf } = this.handlers;
    try {
      const canvas = this.compositeCanvas;
      const off = new OffscreenCanvas(canvas.width, canvas.height);
      const octx = off.getContext("2d");
      if (octx) {
        octx.drawImage(canvas, 0, 0);
        const img = off.transferToImageBitmap();
        onPreview?.(img);
      }
    } catch {
      /* ignore preview errors */
    }
    onPerf?.(Math.round(this.frameCount / Math.max(1, now - this.rafStart) * 1000));
  }

  /** Stop recording; returns the webm as a Blob wrapper for saving. */
  async stopRecording(): Promise<Blob | null> {
    if (!this.recorder) return null;
    this.recording = false;

    const rec = this.recorder;
    this.recorder = null;
    const chunks = this.chunks;
    this.chunks = [];
    const done = new Promise<Blob | null>((resolve) => {
      const h = () => {
        const full = new Blob(chunks, { type: "video/webm" });
        this.handlers.onRecordingState?.(false);
        resolve(full);
      };
      // Final dataavailable (tail) then 'stop'.
      rec.addEventListener("dataavailable", (e: Event) => {
        const d = (e as unknown as { data?: Blob }).data;
        if (!d || d.size === 0) return;
        if (this.sessionActive) {
          this.chunkChain = this.chunkChain.then(async () => {
            const bytes = new Uint8Array(await d.arrayBuffer());
            await dcInvoke("recording_chunk", { bytes });
          }).catch(() => {});
        } else {
          chunks.push(d);
        }
      });
      rec.addEventListener("stop", h, { once: true });
      rec.stop();
    });
    const blob = await done;

    // Drain the ordered flush chain, flush remaining camera samples, then
    // close the main-process session (this is what finalizes the sidecar).
    if (this.recTickTimer) { clearInterval(this.recTickTimer); this.recTickTimer = null; }
    const durationMs = this.recStartWallMs ? Date.now() - this.recStartWallMs : 0;
    this.recStartWallMs = 0;
    if (this.sessionActive) {
      await this.chunkChain.catch(() => {});
      this.sessionActive = false;
      try {
        const path = await dcInvoke<string>("recording_end", { durationMs, mouseSamples: this.mouseSamples, regionRect: this.sessionRegion });
        if (typeof path === "string" && path) this.streamedPath = path;
      } catch (e) {
        console.error("[Recorder] session end failed:", e);
      }
    }
    this.mouseSamples = [];
    for (const t of this.audioTrackRefs) {
      try { t.enabled = true; } catch { /* ignore */ }
    }
    this.audioTrackRefs = [];
    if (this.audioMixer) {
      try {
        this.audioMixer.sources.forEach((s) => s.disconnect());
      } catch { /* ignore */ }
      try { void this.audioMixer.ctx.close(); } catch { /* ignore */ }
      this.audioMixer = null;
    }
    this.ffMode = false;
    return blob;
  }

  async rewind(seconds: number): Promise<void> {
    void seconds;
    // MediaRecorder cannot truncate; kept for interface compatibility.
  }

  getState(): string {
    return this.recording ? "recording" : "idle";
  }

  get springCamera(): SpringCamera {
    return this.spring;
  }

  get smartZoom(): SmartZoom {
    return this.smart;
  }

  /** Live simulated focus camera (normalized center + zoom). The preview
   *  draws the box this describes; export renders the same curve. */
  get focusPreview(): { cx: number; cy: number; scale: number } | null {
    if (!this.spring || !useStore.getState().settings.zoomEnabled) return null;
    const st = this.spring.state;
    return { cx: st.x, cy: st.y, scale: st.scale };
  }

  /** Public read access used by the hook / preview video binding. */
  get screenStreamPublic(): MediaStream | null {
    return this.screenStream;
  }

  get screenVideoPublic(): HTMLVideoElement | null {
    return this.screenVideo;
  }

  /** True while any live input (screen or webcam) could feed the composite,
   *  so the idle preview knows whether to stay on the canvas or fall back. */
  get hasPreviewSource(): boolean {
    return this.screenVideo != null || this.webcamVideo != null;
  }

  /** Public access to the composed canvas so UI can show zoom/effects live. */
  get compositeCanvasPublic(): HTMLCanvasElement | null {
    return this.compositeCanvas;
  }

  /** Update runtime settings (fps, resolution, zoom, audio). */
  updateSettings(patch: Partial<RecorderSettings>): void {
    this.settings = { ...this.settings, ...patch };
    this.smart.updateConfig({
      enabled: this.settings.zoomEnabled,
      zoomLevel: this.settings.zoomLevel,
    });
  }

  /** Attach/replace the error callback (startup wires it to UI feedback). */
  setErrorHandler(fn: ((message: string) => void) | undefined): void {
    this.handlers.onError = fn;
  }

  /** Merge late-arriving callbacks into the handler set. The singleton is
   *  typically created by the first getDirector() call BEFORE callers that
   *  pass callbacks (elapsed/perf feeds) get a say — without this merge
   *  their handlers would be silently dropped. */
  setHandlers(patch: RecorderHandlers): void {
    this.handlers = { ...this.handlers, ...patch };
  }

  dispose(): void {
    this.recording = false;
    this.stopPreviewLoop();
    this.screenStream?.getVideoTracks().forEach((t) => t.stop());
    this.webcamStream?.getVideoTracks().forEach((t) => t.stop());
    this.recorder = null;
  }

  private frameCount = 0;
  private rafStart = Date.now();
}