import { useRef } from "react";
import { useEffect } from "react";
import { useStore } from "../store";
import { useTauriEvent } from "./useTauriEvent";
import { getDirector } from "../recording/director";

interface PerfPayload { fps: number; cpu_percent: number; dropped_frames: number; encoding_latency_ms: number; }
interface TimePayload { elapsed_ms: number; }
interface StatePayload { is_recording: boolean; }
interface AudioStatePayload { source: string; loopback_active: boolean; mic_active: boolean; }
interface CursorPayload { x: number; y: number; }

export function useRecorderState() {
  const setRecording = useStore((s) => s.setRecording);
  const handlingRef = useRef(false);

  // Feed composer perf/elapsed into the store once we have a director.
  useEffect(() => {
    getDirector({
      onElapsed: (ms) => setRecording({ elapsedMs: ms }),
      onPerf: (fps) => setRecording({ fps: Math.round(fps) }),
    });
  }, [setRecording]);

  useTauriEvent<PerfPayload>("perf-update", (p) => {
    setRecording({ fps: Math.round(p.fps) });
  });

  useTauriEvent<TimePayload>("time-update", (p) => {
    setRecording({ elapsedMs: p.elapsed_ms });
  });

  useTauriEvent<CursorPayload>("dc-cursor", (p) => {
    try {
      getDirector().recorder.setCursorPosition(p.x, p.y);
    } catch { /* ignore */ }
  });

  useTauriEvent<StatePayload>("recording-state", async (p) => {
    if (handlingRef.current) return;
    const currentState = useStore.getState().recording.isRecording;
    if (p.is_recording === currentState) return;

    handlingRef.current = true;
    try {
      const dir = getDirector();
      if (p.is_recording) {
        setRecording({ isRecording: true, elapsedMs: 0, fps: 0 });
        await dir.beginRecording();
      } else {
        const savePath = await dir.stopAndSave();
        if (savePath) {
          try { localStorage.setItem("dc_last_save", savePath); } catch {}
        }
        setRecording({ isRecording: false, elapsedMs: 0, fps: 0 });
      }
    } catch (e) {
      console.error("Shortcut recording command failed:", e);
      setRecording({ isRecording: false });
    } finally {
      handlingRef.current = false;
    }
  });

  useTauriEvent<AudioStatePayload>("audio-state", (p) => {
    setRecording({
      audioSource: p.source as "system" | "mic" | "both",
      loopbackActive: p.loopback_active,
      micActive: p.mic_active,
    });
  });
}