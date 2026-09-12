import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { shell } from "electron";

export const isDev = !!process.env.VITE_DEV_SERVER_URL;
export const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";

/** Resolve a path relative to the project root. */
export function projectPath(...segs: string[]): string {
  return path.join(__dirname, "..", ...segs);
}

/** Locate the bundled ffmpeg (from src-tauri) at runtime / dev. */
export function resolveFfmpeg(): string | null {
  const candidates = [
    projectPath("src-tauri", "ffmpeg.exe"),
    path.join(process.resourcesPath || "resources", "ffmpeg.exe"),
    path.join(process.resourcesPath || "resources", "bin", "ffmpeg.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** App data directory for recordings / settings. */
export function appData(...segs: string[]): string {
  return path.join(os.homedir(), "DirectorCam", ...segs);
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function shellOpen(target: string): void {
  if (target.startsWith("http://") || target.startsWith("https://")) {
    void shell.openExternal(target).catch(() => {});
    return;
  }
  void shell.openPath(target).catch(() => {});
}

export function revealInDir(p: string): void {
  shell.showItemInFolder(p.replace(/\//g, "\\"));
}

/** Save a byte array to the recordings directory. Returns full path. */
export function saveRecordingBytes(userDataDir: string, bytes: Uint8Array | number[]): string | null {
  try {
    ensureDir(userDataDir);
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const name = `DirectorCam_${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}` +
      `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.webm`;
    const target = path.join(userDataDir, name);
    fs.writeFileSync(target, Buffer.from(bytes));
    return target;
  } catch (e) {
    console.error("[directorcam] save failed", e);
    return null;
  }
}