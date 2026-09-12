/**
 * RecorderCoordinator — owns the live screen stream, the composition canvas,
 * the spring camera + smart zoom, the MediaRecorder encode, and emits
 * `preview-frame` / recording lifecycle events.
 *
 * Flow (Electron-native, high performance):
 *   Screen (getDisplayMedia) ─▶ canvas compose (GPU) ─▶ MediaRecorder ─▶ .webm
 *   Webcam (getUserMedia)    ──────────┘ (overlay)
 *   Audio (loopback/mic)     ──────────────────────────┘ (muxed in)
 */

import type { SpringCamera } from "./SpringCamera";
import type { SmartZoom } from "./SmartZoom";

export interface RecorderFullOptions {
  sourceId?: string;
  fps: number;
  width: number;
  height: number;
  bitrateMbps: number;
  codec: "h264" | "h265" | "vp9" | "av1";
  audioSource: "system" | "mic" | "both";
  webcamEnabled: boolean;
  zoomEnabled: boolean;
  zoomLevel: number;
}

export interface RecorderEngine {
  spring: SpringCamera;
  smart: SmartZoom;
}

export interface RecorderEvents {
  onPreview: (bitmap: ImageBitmap) => void;
  onState: (state: { isRecording: boolean }) => void;
  onPerf: (perf: { fps: number; cpuPercent: number }) => void;
  onTime: (elapsedMs: number) => void;
  onSave: (filePath: string) => void;
  onError: (message: string) => void;
}

export type RecorderState =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "error";