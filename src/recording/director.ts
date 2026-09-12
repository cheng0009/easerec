/**
 * Global Director facade — a module-level singleton that owns the live screen
 * capture + composer. Callable from any component (ControlBar, PreviewArea,
 * hooks) without prop-drilling. Bridges to the zustand store for UI state.
 */

import { Recorder } from "./Recorder";
import type { RecorderHandlers } from "./Recorder";

let rec: Recorder | null = null;

export interface DirectorPublic {
  recorder: Recorder;
  startScreen: () => Promise<boolean>;
  beginRecording: (canvas?: HTMLCanvasElement | null) => Promise<void>;
  stopRecording: () => Promise<Blob | null>;
  /** Stop + persist to disk, returning the saved path or null. */
  stopAndSave: () => Promise<string | null>;
  isRecording: () => boolean;
  setZoomEnabled: (v: boolean) => void;
  setZoomLevel: (v: number) => void;
  dispose: () => void;
}

/** Save a Blob to a webm via the main-process bridge. */
async function persistBlob(blob: Blob): Promise<string | null> {
  const g = globalThis as unknown as {
    __directorcam?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
  if (!g.__directorcam) return null;
  const buf = new Uint8Array(await blob.arrayBuffer());
  const head = Array.from(buf.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  console.log(`[persistBlob] size=${buf.length} head=[${head}]`);
  // Pass the typed array directly so Electron IPC uses efficient structured
  // clone (prevents the huge/indexed number[] conversion that can exceed IPC limits).
  return g.__directorcam.invoke("__dc_save_recording", {
    bytes: buf,
  }) as Promise<string | null>;
}

function ensureRecorder(handlers: RecorderHandlers = {}): Recorder {
  if (!rec) {
    rec = new Recorder({}, handlers);
  }
  return rec;
}

export function getDirector(handlers: RecorderHandlers = {}): DirectorPublic {
  const r = ensureRecorder(handlers);

  return {
    recorder: r,
    startScreen: () => r.startScreen(),
    beginRecording: async (canvas) => {
      let target = canvas;
      if (!target) target = document.getElementById("recording-canvas") as HTMLCanvasElement | null;
      if (!target) target = null;
      await r.startRecording(target);
    },
    stopRecording: () => r.stopRecording(),
    stopAndSave: async () => {
      // Prefer the main-process streamed file (incremental flush); the blob
      // path is only the fallback when the streaming session was unavailable.
      const blob = await r.stopRecording();
      const streamed = r.consumeStreamedPath();
      if (streamed) return streamed;
      if (!blob || blob.size === 0) return null;
      return persistBlob(blob);
    },
    isRecording: () => r.getState() === "recording",
    setZoomEnabled: (v: boolean) => r.smartZoom.updateConfig({ enabled: v }),
    setZoomLevel: (v: number) => r.smartZoom.updateConfig({ zoomLevel: v }),
    dispose: () => {
      rec?.dispose();
      rec = null;
    },
  };
}