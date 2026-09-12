/**
 * Shared record start/stop flow used by BOTH the ControlBar button and the
 * global F9 hotkey so they behave identically:
 *
 *   START -> the app window minimizes; in region mode the user first
 *            box-selects the record area on the desktop overlay (ESC
 *            cancels), then a 3-2-1 countdown renders at the center of the
 *            primary display. Only when the countdown ends does the actual
 *            recording begin.
 *   Pressing START again during the countdown cancels it (no recording).
 *   STOP  -> immediate, no countdown.
 */

import { useStore } from "../store";
import { getDirector } from "./director";
import { getCurrentWindow } from "../bridge/window";
import { closeOpenMarksOnStop, resetMarksForNewRecording } from "./marks";

let countdownTimer: ReturnType<typeof setInterval> | null = null;
let countdownCancelled = false;
/** True while the overlay box-select (region mode) is in progress. */
let regionSelecting = false;

export function isCountdownActive(): boolean {
  return useStore.getState().effects.countdown != null;
}

/** Cancel any pending countdown (a second F9 / button press during 3-2-1). */
export function cancelCountdown(): void {
  countdownCancelled = true;
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  const st = useStore.getState();
  if (st.effects.countdown != null) st.setEffects({ countdown: null });
}

/** Run the 3-2-1 overlay countdown (3 → 2 → 1, one second each), then fire
 *  doStart(). Unless cancelled by a second press in the meantime. */
export function scheduleRecordingStart(doStart: () => Promise<void>): void {
  countdownCancelled = false;
  useStore.getState().setEffects({ countdown: 3 });
  let value = 3;
  countdownTimer = setInterval(() => {
    value -= 1;
    if (value <= 0) {
      if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
      // Clear the overlay countdown FIRST, then wait a beat before rolling:
      // the final "1" is painted on the captured desktop, and starting the
      // recorder in the same tick would bake it into the video's first frames.
      useStore.getState().setEffects({ countdown: null });
      if (!countdownCancelled) {
        setTimeout(() => {
          if (!countdownCancelled) void doStart();
        }, 450);
      }
    } else {
      useStore.getState().setEffects({ countdown: value });
    }
  }, 1000);
}

/**
 * Toggle recording: returns the saved file path when a recording was STOPPED
 * (so the UI can show where it landed), otherwise null.
 */
export async function toggleRecording(): Promise<string | null> {
  const st = useStore.getState();

  // Second press during the countdown = cancel it.
  if (isCountdownActive()) {
    cancelCountdown();
    return null;
  }

  // STOP — immediate, no countdown.
  if (st.recording.isRecording) {
    st.setRecording({ isRecording: false });
    closeOpenMarksOnStop();
    try {
      const path = await getDirector().stopAndSave();
      if (path) {
        try { localStorage.setItem("dc_last_save", path); } catch {}
      }
      return path;
    } catch (e) {
      console.error("[record] stop failed:", e);
      return null;
    }
  }

  // START — minimize the app; in region mode box-select the record area on
  // the overlay FIRST (the user drags before the countdown rolls), then the
  // countdown, then recording.
  try { await getCurrentWindow().minimize(); } catch { /* ignore */ }
  if (st.recording.regionMode) {
    if (regionSelecting) {
      // Second press while dragging the box = cancel the selection.
      regionSelecting = false;
      await getDirector().recorder.cancelRegionSelection();
      try { await getCurrentWindow().unminimize(); } catch { /* ignore */ }
      return null;
    }
    regionSelecting = true;
    const rect = await getDirector().recorder.selectRegionOnOverlay();
    regionSelecting = false;
    if (!rect) {
      // User cancelled the region selection (ESC / click / second press).
      try { await getCurrentWindow().unminimize(); } catch { /* ignore */ }
      return null;
    }
    st.setRecording({ regionRect: rect });
  }
  scheduleRecordingStart(async () => {
    const s = useStore.getState();
    s.setRecording({ isRecording: true, elapsedMs: 0, pausedMs: 0 });
    resetMarksForNewRecording(null);
    try {
      const dir = getDirector();
      // User recording settings take effect at session start.
      dir.recorder.applySettings({
        fps: s.settings.fps,
        resolution: s.settings.resolution,
        bitrateMbps: s.settings.bitrateMbps,
      });
      // Switch the capture source if the user picked one that differs.
      const src = s.recording.sourceId;
      if (src && src !== dir.recorder.activeSourceId) {
        await dir.recorder.switchSource(src);
      }
      // Region mode always captures the PRIMARY screen: the selection rect is
      // normalized to the primary display, so a window picked earlier must
      // not leak into this capture (switchSource(null) clears it in main).
      if (s.recording.regionMode) {
        await dir.recorder.switchSource(null);
      }
      await dir.beginRecording();
      if (s.recording.regionMode && s.recording.regionRect) {
        await dir.recorder.setSessionRegion(s.recording.regionRect);
      }
    } catch (e) {
      console.error("[record] begin failed:", e);
      s.setRecording({ isRecording: false });
      try { await getCurrentWindow().unminimize(); } catch { /* ignore */ }
    }
  });
  return null;
}