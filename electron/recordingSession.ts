/**
 * Recording session — owns the on-disk side of one recording:
 *
 *   DirectorCam_YYYY_MM_DD_HHMMSS.webm          MediaRecorder chunks, appended
 *                                              as they arrive (streaming webm:
 *                                              the first chunk carries the EBML
 *                                              header, later chunks are clusters)
 *   DirectorCam_....webm.edits.json             EDL sidecar (see src/recording/edl.ts)
 *   DirectorCam_....webm.camtrack.jsonl         one camera-crop sample per line
 *                                              (for the vertical reframe export)
 *
 * Chunk append + sidecar writes give three features their foundation: the
 * privacy backtrace can scan the partial file while recording, a crash leaves
 * everything written so far recoverable, and renderer memory stays bounded.
 *
 * The class wraps plain fs so tests can point it at a temp directory.
 */

import fs from "node:fs";
import path from "node:path";
import { emptyEdl, parseEdl, replaceEdit, appendEdit, type EdlFile, type EditEntry } from "../src/recording/edl";

export interface SessionPaths {
  webmPath: string;
  editsPath: string;
  camTrackPath: string;
  mouseTrackPath: string;
  regionPath: string;
}

export interface RecordRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function timestampedName(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `DirectorCam_${d.getFullYear()}_${pad(d.getMonth() + 1)}_${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function sidecarPaths(webmPath: string): SessionPaths {
  return {
    webmPath,
    editsPath: webmPath + ".edits.json",
    camTrackPath: webmPath + ".camtrack.jsonl",
    mouseTrackPath: webmPath + ".mouse.jsonl",
    regionPath: webmPath + ".region.json",
  };
}

/** Write the EDL atomically (tmp file + rename) so a crash mid-write cannot
 *  leave a torn JSON behind. */
export function writeEdlFile(editsPath: string, edl: EdlFile): void {
  const tmp = editsPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(edl, null, 2), "utf8");
  fs.renameSync(tmp, editsPath);
}

export function readEdlFile(editsPath: string): EdlFile {
  try {
    const txt = fs.readFileSync(editsPath, "utf8").replace(/^\uFEFF/, "");
    const parsed = parseEdl(JSON.parse(txt));
    if (parsed) return parsed;
  } catch { /* missing/corrupt -> fresh */ }
  return emptyEdl();
}

export class RecordingSession {
  readonly paths: SessionPaths;
  private edl: EdlFile;
  private bytesWritten = 0;
  private closed = false;

  private constructor(paths: SessionPaths, edl: EdlFile) {
    this.paths = paths;
    this.edl = edl;
  }

  /** Start a brand-new session (fresh timestamped files). */
  static begin(dir: string, now = new Date()): RecordingSession {
    fs.mkdirSync(dir, { recursive: true });
    const paths = sidecarPaths(path.join(dir, timestampedName(now) + ".webm"));
    const edl = emptyEdl(now.toISOString());
    // Truncate in case the same-second name collides with an abandoned file.
    fs.writeFileSync(paths.webmPath, Buffer.alloc(0));
    writeEdlFile(paths.editsPath, edl);
    try { fs.writeFileSync(paths.camTrackPath, ""); } catch { /* optional */ }
    return new RecordingSession(paths, edl);
  }

  /** Adopt files that already exist (crash recovery). */
  static adopt(webmPath: string): RecordingSession {
    const paths = sidecarPaths(webmPath);
    const session = new RecordingSession(paths, readEdlFile(paths.editsPath));
    try {
      session.bytesWritten = fs.statSync(webmPath).size;
    } catch { session.bytesWritten = 0; }
    return session;
  }

  get webmBytes(): number {
    return this.bytesWritten;
  }

  getEdl(): EdlFile {
    return { ...this.edl, edits: [...this.edl.edits] };
  }

  /** Append one MediaRecorder chunk. Order matters: callers must serialize. */
  appendChunk(bytes: Uint8Array): void {
    if (this.closed) return;
    fs.appendFileSync(this.paths.webmPath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.bytesWritten += bytes.byteLength;
  }

  /** Append a camera-crop sample line (vertical reframe source data). */
  appendCameraSample(sample: { tMs: number; x: number; y: number; w: number; h: number }): void {
    if (this.closed) return;
    try {
      fs.appendFileSync(this.paths.camTrackPath, JSON.stringify(sample) + "\n");
    } catch { /* cam track is best-effort */ }
  }

  /** Persist the record region (global crop for the export pass). */
  setRecordRegion(rect: RecordRegion): void {
    if (this.closed) return;
    try {
      fs.writeFileSync(this.paths.regionPath, JSON.stringify(rect), "utf8");
    } catch { /* region is best-effort */ }
  }

  /** Append mouse-trajectory samples (export-time follow-focus source). */
  appendMouseSamples(samples: { tMs: number; x: number; y: number }[]): void {
    if (this.closed || !samples.length) return;
    try {
      const lines = samples.map((s) => JSON.stringify(s)).join("\n") + "\n";
      fs.appendFileSync(this.paths.mouseTrackPath, lines);
    } catch { /* mouse track is best-effort */ }
  }

  /** Record an edit and persist the sidecar. Returns the normalized index. */
  addEdit(edit: EditEntry): { index: number; edl: EdlFile } {
    if (this.closed) return { index: -1, edl: this.getEdl() };
    this.edl = appendEdit(this.edl, edit);
    writeEdlFile(this.paths.editsPath, this.edl);
    return { index: this.edl.edits.findIndex((e) => e === this.edl.edits[this.edl.edits.length - 1]), edl: this.getEdl() };
  }

  /** Overwrite the edit at `index` (timeline review drag / backtrace update). */
  updateEdit(index: number, edit: EditEntry): EdlFile {
    if (this.closed) return this.getEdl();
    this.edl = replaceEdit(this.edl, index, edit);
    writeEdlFile(this.paths.editsPath, this.edl);
    return this.getEdl();
  }

  /** Replace the whole edit list (used when the backtrace rewrites a mask). */
  setEdits(edits: EditEntry[]): EdlFile {
    let next: EdlFile = { ...this.edl, edits: [] };
    for (const e of edits) next = appendEdit(next, e);
    this.edl = next;
    writeEdlFile(this.paths.editsPath, this.edl);
    return this.getEdl();
  }

  /** Mark the recording finished (duration known, session complete). */
  end(durationMs: number): void {
    if (this.closed) return;
    this.edl = { ...this.edl, durationMs: Math.max(0, Math.round(durationMs)), finalized: true };
    writeEdlFile(this.paths.editsPath, this.edl);
    this.closed = true;
  }
}

export interface RecordingEntry {
  webmPath: string;
  editsPath: string;
  finalized: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

/** Enumerate recordings in a directory with their crash-recovery state. */
export function listRecordings(dir: string): RecordingEntry[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: RecordingEntry[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".webm")) continue;
    const webmPath = path.join(dir, name);
    try {
      const st = fs.statSync(webmPath);
      if (!st.isFile()) continue;
      const editsPath = webmPath + ".edits.json";
      let finalized = false;
      try {
        finalized = readEdlFile(editsPath).finalized;
      } catch { finalized = false; }
      out.push({ webmPath, editsPath, finalized, sizeBytes: st.size, mtimeMs: st.mtimeMs });
    } catch { /* unreadable entry */ }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
