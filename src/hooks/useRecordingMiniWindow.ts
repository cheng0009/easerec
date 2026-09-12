import { useEffect } from "react";
import { useStore } from "../store";
import { listenEvent } from "../lib/tauri";

function dcInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const g = globalThis as unknown as {
    __directorcam?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T> };
  };
  if (!g.__directorcam) return Promise.reject(new Error("bridge unavailable"));
  return g.__directorcam.invoke(cmd, args);
}

/**
 * Keeps the pure-stage mini console in sync: pushes a compact state snapshot
 * whenever recording/webcam/audio/source changes plus a 1s timer tick while
 * recording, and serves the mini window's open-source-picker / query-state
 * requests (relayed through the main process).
 */
export function useRecordingMiniWindow() {
  const isRecording = useStore((s) => s.recording.isRecording);

  useEffect(() => {
    let lastJson = "";

    const pushState = () => {
      const s = useStore.getState();
      const state = {
        recording: s.recording.isRecording,
        paused: s.recording.isPaused,
        audio: s.recording.audioSource,
        webcam: s.webcam.enabled,
        sourceName: s.recording.sourceName,
      };
      const json = JSON.stringify(state);
      if (json === lastJson) return;
      lastJson = json;
      void dcInvoke("mini_state_update", state).catch(() => {});
    };

    const unsub = useStore.subscribe(pushState);
    pushState();

    const timer = setInterval(() => {
      if (useStore.getState().recording.isRecording) {
        void dcInvoke("mini_time_update", { elapsed_ms: useStore.getState().recording.elapsedMs }).catch(() => {});
      }
    }, 1000);

    const p1 = listenEvent<unknown>("dc-mini-open-source-picker", () => {
      useStore.getState().setUi({ sourcePickerOpen: true });
    }).catch(() => {});
    const p2 = listenEvent<unknown>("dc-mini-query-state", () => {
      lastJson = ""; // force a fresh push
      pushState();
    }).catch(() => {});

    return () => {
      unsub();
      clearInterval(timer);
      void p1; void p2;
    };
  }, [isRecording]);
}
