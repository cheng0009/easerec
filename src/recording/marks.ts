/**
 * Renderer-side mark orchestration. Every "mark now, apply at export" feature
 * (rewind, privacy mask, privacy whole-cut, fast-forward) funnels through
 * here: it derives timestamps from the recorder's clock, talks to the main
 * process (EDL sidecar + overlay control) and mirrors the EDL into the store
 * for the timeline / status UI.
 *
 * The store mirror is display-only; the main-process session owns the
 * authoritative sidecar file.
 */

import { useStore } from "../store";
import { getDirector } from "./director";
import { listenEvent, tauriInvoke } from "../lib/tauri";
import type { EditEntry, MaskRegion } from "./edl";
import type { SettingsState } from "../store/types";
import { isZhLang } from "../lib/useLang";

function dcInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const g = globalThis as unknown as {
    __directorcam?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T> };
  };
  if (!g.__directorcam) return Promise.reject(new Error("bridge unavailable"));
  return g.__directorcam.invoke(cmd, args);
}

function nowMs(): number {
  try { return Math.max(0, getDirector().recorder.getElapsedMs()); }
  catch { return 0; }
}

function feedback(message: string): void {
  useStore.getState().setMarks({ feedback: message });
  // Auto-clear after a moment so the status bar doesn't stay noisy.
  setTimeout(() => {
    const cur = useStore.getState().marks.feedback;
    if (cur === message) useStore.getState().setMarks({ feedback: null });
  }, 4000);
}

async function appendEdit(edit: EditEntry): Promise<void> {
  try {
    const res = await dcInvoke<{ index: number; edl: { edits: EditEntry[] } }>("edl_append", { edit });
    if (res && Array.isArray(res.edl?.edits)) {
      useStore.getState().setMarks({ edits: res.edl.edits });
    }
  } catch (e) {
    console.error("[marks] append failed:", e);
  }
}

// ---------------------------------------------------------------------------
// Pause / resume (F10) — auto-cut at export
// ---------------------------------------------------------------------------

export async function togglePause(): Promise<void> {
  const st = useStore.getState();
  if (!st.recording.isRecording) return;
  if (st.marks.activePause) {
    const start = st.marks.activePause.startMs;
    const end = nowMs();
    await appendEdit({ type: "cut", startMs: start, endMs: Math.max(start + 200, end), reason: "pause" });
    st.setMarks({ activePause: null });
    st.setRecording({ isPaused: false, pausedMs: st.recording.pausedMs + Math.max(200, end - start) });
    feedback(isZhLang() ? "▶ 已恢复录制" : "▶ Resumed");
  } else {
    st.setMarks({ activePause: { startMs: nowMs() } });
    st.setRecording({ isPaused: true });
    feedback(isZhLang() ? "⏸ 已暂停 — 暂停段不会出现在成片中（F10 恢复）" : "⏸ Paused — the pause won’t appear in the film (F10 to resume)");
  }
}

/** True when paused: block other marks to keep the EDL sane. */
function paused(): boolean {
  return useStore.getState().marks.activePause != null;
}

// ---------------------------------------------------------------------------
// Privacy whole-cut (Shift+F6) — full-screen private activity
// ---------------------------------------------------------------------------

export async function togglePrivacyCut(): Promise<void> {
  const st = useStore.getState();
  if (!st.recording.isRecording) return;
  if (paused()) { feedback(isZhLang() ? "已暂停 — 先按 F10 恢复" : "Paused — press F10 to resume"); return; }
  if (st.marks.activePrivacyCut) {
    const start = st.marks.activePrivacyCut.startMs;
    const end = nowMs();
    try { await dcInvoke("overlay_privacy_cut", { on: false }); } catch { /* ignore */ }
    if (end - start >= 200) {
      await appendEdit({ type: "cut", startMs: start, endMs: end, reason: "privacy" });
      feedback(isZhLang() ? `🔒 隐私区间已标记（${((end - start) / 1000).toFixed(1)} 秒，导出时剪除）` : `🔒 Privacy range marked (${((end - start) / 1000).toFixed(1)}s, cut at export)`);
    } else {
      feedback(isZhLang() ? "🔒 隐私区间过短，已忽略" : "🔒 Range too short, ignored");
    }
    st.setMarks({ activePrivacyCut: null });
  } else {
    try { await dcInvoke("overlay_privacy_cut", { on: true }); } catch { /* ignore */ }
    st.setMarks({ activePrivacyCut: { startMs: nowMs() } });
    feedback(isZhLang() ? "🔴 隐私剪辑中 — 屏幕上方有红色提示，再次按 Shift+F6 结束" : "🔴 Privacy cutting — red banner on screen, press Shift+F6 again to end");
  }
}

// ---------------------------------------------------------------------------
// Fast-forward (F4) — mark a speedup range
// ---------------------------------------------------------------------------

export async function toggleFF(): Promise<void> {
  const st = useStore.getState();
  if (!st.recording.isRecording) return;
  if (paused()) { feedback(isZhLang() ? "已暂停 — 先按 F10 恢复" : "Paused — press F10 to resume"); return; }
  const director = getDirector();
  if (st.marks.activeFF) {
    const start = st.marks.activeFF.startMs;
    const end = nowMs();
    director.recorder.setFFMode(false);
    if (end - start >= 500) {
      const [lo, hi] = st.settings.ffTargetSecs;
      await appendEdit({ type: "speedup", startMs: start, endMs: end, targetSecs: [lo, hi], audio: "whoosh" });
      feedback(isZhLang() ? `⏩ 快进段已标记（${((end - start) / 1000).toFixed(0)} 秒 → 导出时压缩）` : `⏩ FF range marked (${((end - start) / 1000).toFixed(0)}s → compressed at export)`);
    } else {
      feedback(isZhLang() ? "⏩ 快进段过短，已取消" : "⏩ FF too short, cancelled");
    }
    st.setMarks({ activeFF: null });
  } else {
    director.recorder.setFFMode(true);
    st.setMarks({ activeFF: { startMs: nowMs() } });
    feedback(isZhLang() ? "⏩ 视频快进中... 再次按 F4 结束" : "⏩ Fast-forwarding… press F4 again to end");
  }
}

// ---------------------------------------------------------------------------
// Privacy mask (F6) — live box + content backtrace
// ---------------------------------------------------------------------------

export async function startPrivacyDraw(): Promise<void> {
  const st = useStore.getState();
  if (!st.recording.isRecording || st.marks.activePrivacy || st.marks.privacyDrawing) return;
  st.setMarks({ privacyDrawing: true });
  // Hard re-arm: flush any stale overlay draw state or leftover box rect from
  // a previous session BEFORE switching draw mode on, so F6 always ends with a
  // fresh, armed overlay even if an earlier on/off event was missed or raced.
  try { await dcInvoke("overlay_privacy_box", { rect: null }); } catch { /* overlay may be down */ }
  try { await dcInvoke("overlay_privacy_draw", { on: false }); } catch { /* overlay may be down */ }
  try { await dcInvoke("overlay_privacy_draw", { on: true }); } catch { /* overlay may be down */ }
}

export async function togglePrivacy(): Promise<void> {
  const st = useStore.getState();
  if (!st.recording.isRecording) {
    feedback(isZhLang() ? "⏺ 请先开始录制再使用隐私遮挡（F6）" : "⏺ Start recording before using the privacy mask (F6)");
    return;
  }
  if (paused()) { feedback(isZhLang() ? "已暂停 — 先按 F10 恢复" : "Paused — press F10 to resume"); return; }
  if (st.marks.activePrivacy) {
    await endPrivacyMask();
  } else if (st.marks.privacyDrawing) {
    // F6 while dragging = cancel the box selection.
    st.setMarks({ privacyDrawing: false });
    try { await dcInvoke("overlay_privacy_draw", { on: false }); } catch { /* ignore */ }
    feedback(isZhLang() ? "已取消遮挡框选" : "Box selection cancelled");
  } else {
    await startPrivacyDraw();
  }
}

/** Overlay finished a drag: map to source coords, sample the reference, register the mask. */
async function handlePrivacyRegion(screenRect: MaskRegion): Promise<void> {
  const st = useStore.getState();
  st.setMarks({ privacyDrawing: false });
  const director = getDirector();
  // Clamp any overhang into the captured source (a box that hangs off a
  // window/display must not silently vanish) — only a fully-outside box is
  // refused, with clear feedback.
  const mapped = director.recorder.mapPrivacyRegion(screenRect);
  if (!mapped) {
    feedback(isZhLang() ? "⚠ 遮挡框在录制画面外（另一块屏/窗口），未遮挡 — 请对准录制内容再按 F6" : "⚠ Box is outside the captured frame — point at the recording and press F6 again");
    await clearPrivacyOverlay();
    return;
  }
  const { rect, clipped } = mapped;
  if (clipped) {
    feedback(isZhLang() ? "⚠ 遮挡框部分超出录制画面，已自动收缩到画面内" : "⚠ Mask trimmed to the captured frame (part was outside)");
  }
  let ref = { region: "0000000000000000", frame: "0000000000000000", pixels: "" };
  try { ref = director.recorder.samplePrivacyReference(rect); }
  catch (e) { console.error("[marks] reference sampling failed:", e); }

  const fallbackStart = Math.max(0, nowMs() - st.settings.privacyGraceS * 1000);
  try {
    const res = await dcInvoke<{ index: number }>("privacy_mark_start", {
      region: rect,
      refRegionHash: ref.region,
      refFrameHash: ref.frame,
      refPixels: ref.pixels,
      fallbackStartMs: fallbackStart,
      nowMs: nowMs(),
    });
    st.setMarks({ activePrivacy: { startMs: fallbackStart } });
    // Show the mosaic at the CLAMPED box's screen position so what the user
    // sees is exactly what gets masked.
    const boxScreen = director.recorder.mapSourceToScreenRegion(rect);
    try { await dcInvoke("overlay_privacy_box", { rect: boxScreen }); } catch { /* ignore */ }
    feedback(isZhLang() ? "🛡 遮挡已生效 — 屏幕将一直盖住该区域，再按 F6 结束" : "🛡 Mask live — it stays until you press F6 again");
    void res;
  } catch (e) {
    console.error("[marks] privacy_mark_start failed:", e);
    feedback(isZhLang() ? "⚠ 隐私遮挡注册失败，请重试" : "⚠ Mask registration failed, try again");
    await clearPrivacyOverlay();
  }
}

async function clearPrivacyOverlay(): Promise<void> {
  try { await dcInvoke("overlay_privacy_draw", { on: false }); } catch { /* ignore */ }
  try { await dcInvoke("overlay_privacy_box", { rect: null }); } catch { /* ignore */ }
}

export async function endPrivacyMask(): Promise<void> {
  const st = useStore.getState();
  if (!st.marks.activePrivacy) return;
  try { await dcInvoke("privacy_mark_end", { nowMs: nowMs() }); } catch { /* ignore */ }
  try { await dcInvoke("overlay_privacy_box", { rect: null }); } catch { /* ignore */ }
  st.setMarks({ activePrivacy: null });
  feedback(isZhLang() ? "🛡 遮挡结束（导出时对整段区间遮罩）" : "🛡 Mask ended (region masked at export)");
}

/** Main-process backtrace resolved the mask start — update the mirror. */
function handleBacktrace(p: { index: number; startMs: number; method: string }): void {
  const st = useStore.getState();
  const edits = [...st.marks.edits];
  if (p.index >= 0 && p.index < edits.length && edits[p.index]?.type === "mask") {
    const m = { ...(edits[p.index] as { startMs: number; pending?: boolean; startSource?: string }) };
    m.startMs = p.startMs;
    m.pending = false;
    m.startSource = p.method;
    edits[p.index] = m as EditEntry;
    st.setMarks({ edits });
  }
  const zh = isZhLang();
  const label = p.method === "match" ? (zh ? "内容+页面匹配" : "content+page match") : p.method === "neighborhood" ? (zh ? "邻域匹配" : "neighborhood match") : (zh ? "区域匹配" : "region match");
  feedback(`✅ ${zh ? "已回溯到" : "Backtraced to"} ${Math.floor(p.startMs / 60000)}:${String(Math.floor((p.startMs % 60000) / 1000)).padStart(2, "0")}（${label}）${zh ? "— 遮挡仍在生效，再按 F6 结束" : "— mask still live, press F6 to end"}`);
}

// ---------------------------------------------------------------------------
// Event bridge + recording lifecycle hooks
// ---------------------------------------------------------------------------

let installed = false;

export function installMarksBridge(): void {
  if (installed) return;
  installed = true;

  void listenEvent<{ rect: MaskRegion }>("dc-privacy-region", (p) => {
    if (p?.rect) void handlePrivacyRegion(p.rect);
  }).catch(() => {});

  void listenEvent<{ index: number; startMs: number; method: string }>("dc-privacy-backtrace", (p) => {
    if (p && typeof p.index === "number") handleBacktrace(p);
  }).catch(() => {});

  void listenEvent<{ items: { webmPath: string; sizeBytes: number }[] }>("dc-recovery", (p) => {
    if (p && Array.isArray(p.items) && p.items.length) {
      useStore.getState().setMarks({ recoverable: p.items });
    }
  }).catch(() => {});

  // Hydrate persisted settings (subtitle style, LLM config, glossary, …)
  // from the main-process settings.json.
  void tauriInvoke<Partial<SettingsState>>("get_app_settings").then((s) => {
    let merged: Partial<SettingsState> = {};
    // One-time migration: the pre-hub IntroOutroPanel stored its config in
    // localStorage — carry it into the film-strip settings if unset.
    if (!s?.introPath && !s?.outroPath) {
      try {
        const legacy = JSON.parse(localStorage.getItem("dc_intro_outro") || "{}") as {
          intro_path?: string; intro_duration_s?: number;
          outro_path?: string; outro_duration_s?: number;
        };
        if (legacy.intro_path || legacy.outro_path) {
          merged = {
            introPath: legacy.intro_path || "",
            introDurationS: legacy.intro_duration_s || 3,
            outroPath: legacy.outro_path || "",
            outroDurationS: legacy.outro_duration_s || 3,
          };
        }
      } catch { /* no legacy config */ }
    }
    if (s && typeof s === "object" && Object.keys(s).length > 0) merged = { ...merged, ...s };
    if (Object.keys(merged).length > 0) useStore.getState().setSettings(merged);
  }).catch(() => {});
}

/** Reset per-recording mark state (called when a recording starts). */
export function resetMarksForNewRecording(webmPath: string | null): void {
  useStore.getState().setMarks({
    edits: [],
    webmPath,
    activePrivacy: null,
    activePrivacyCut: null,
    activePause: null,
    activeFF: null,
    privacyDrawing: false,
  });
  useStore.getState().setRecording({ isPaused: false, pausedMs: 0 });
}

/** Called when the recording stops: close any open marks so nothing dangles.
 *  A pause still open at stop-time becomes a cut up to the final moment. */
export function closeOpenMarksOnStop(): void {
  const st = useStore.getState();
  if (st.marks.activePause) {
    const start = st.marks.activePause.startMs;
    const end = nowMs();
    if (end - start >= 200) void appendEdit({ type: "cut", startMs: start, endMs: end, reason: "pause" });
  }
  if (st.marks.activePrivacy) {
    void dcInvoke("overlay_privacy_box", { rect: null }).catch(() => {});
  }
  if (st.marks.privacyDrawing) {
    void dcInvoke("overlay_privacy_draw", { on: false }).catch(() => {});
  }
  if (st.marks.activePrivacyCut) {
    void dcInvoke("overlay_privacy_cut", { on: false }).catch(() => {});
  }
  if (st.marks.activeFF) getDirector().recorder.setFFMode(false);
  st.setMarks({
    activePrivacy: null,
    activePrivacyCut: null,
    activePause: null,
    activeFF: null,
    privacyDrawing: false,
  });
  useStore.getState().setRecording({ isPaused: false });
}
