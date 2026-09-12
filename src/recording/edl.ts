/**
 * Edit Decision List (EDL) — the shared data structure behind every
 * "record now, decide later" feature: rewind, privacy mask, privacy cut,
 * fast-forward, (and in the exporter: silence trim / subtitles / intro-outro
 * are pipeline stages rather than edits).
 *
 * During recording the renderer appends edits through IPC; the main process
 * owns the on-disk sidecar file (`<recording>.edits.json`) and rewrites it
 * atomically on every change. At export time the orchestrator turns the EDL
 * into ffmpeg stages via `buildTimeline`.
 *
 * This module is PURE (no electron / DOM / fs) so it is unit-testable and
 * importable from both the renderer and the main process.
 */

export type EditReason = "rewind" | "privacy" | "pause";

export interface CutEdit {
  type: "cut";
  /** Range removed from the final video, in recording-source ms. */
  startMs: number;
  endMs: number;
  reason: EditReason;
  label?: string;
}

export interface SpeedupEdit {
  type: "speedup";
  startMs: number;
  endMs: number;
  /** Final display duration is clamped into [min,max] seconds regardless of source length. */
  targetSecs: [number, number];
  /** "mute" drops the audio, "whoosh" replaces it with the bundled SFX. */
  audio: "mute" | "whoosh";
}

export interface MaskRegion {
  /** Normalized 0..1 rectangle relative to the captured frame. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MaskEdit {
  type: "mask";
  startMs: number;
  endMs: number;
  region: MaskRegion;
  style: "black" | "blur";
  /** Additionally silence the audio over the masked range. */
  muteAudio: boolean;
  /** How startMs was determined: content backtrace match / grace fallback / manual drag. */
  startSource?: "match" | "neighborhood" | "region" | "dynamic" | "grace" | "manual";
  /** True while the automatic backtrace has not resolved startMs yet. */
  pending?: boolean;
  /** Recording time when the user finished drawing the box (the mosaic starts
   *  covering the content here). The export cuts [startMs → drawnAtMs] (privacy
   *  content visible before it was covered) instead of trying to track it. */
  drawnAtMs?: number;
  /** dHash (hex) of the masked region content — the fingerprint used by the
   *  export-time occurrence scan to find EVERY appearance of that content,
   *  wherever it sits on screen, and mosaic it too. */
  refRegionHash?: string;
  /** Base64 of the 16x16 grayscale region crop (NCC verification crutch for
   *  the occurrence scan). */
  refPixels?: string;
}

export type EditEntry = CutEdit | SpeedupEdit | MaskEdit;

export interface EdlFile {
  version: 1;
  /** Wall-clock duration of the source recording (ms); null while recording. */
  durationMs: number | null;
  /** False until the recording session ends cleanly (crash-recovery signal). */
  finalized: boolean;
  createdAt: string;
  edits: EditEntry[];
}

export interface TimelineSegment {
  /** Source (recording) time range feeding this segment. */
  srcStartMs: number;
  srcEndMs: number;
  /** Where it lands on the output timeline. */
  outStartMs: number;
  outEndMs: number;
  /** Playback speed applied (1 = untouched, >1 = compressed). */
  speed: number;
  /** Which edit (if any) produced this segment. */
  via: "keep" | SpeedupEdit;
}

export interface EdlReport {
  cuts: { count: number; totalMs: number };
  masks: { count: number; totalMs: number };
  speedups: { count: number; sourceMs: number; outputMs: number };
  sourceDurationMs: number;
  outputDurationMs: number;
}

// ---------------------------------------------------------------------------
// Construction / serialization
// ---------------------------------------------------------------------------

export function emptyEdl(createdAt = new Date().toISOString()): EdlFile {
  return { version: 1, durationMs: null, finalized: false, createdAt, edits: [] };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Coerce an unknown record into a valid EditEntry (tolerant of bad JSON).
 *  A negative startMs is clamped to 0 (rewind before recording start); a
 *  non-finite start/end or a negative end rejects the entry. */
export function parseEdit(raw: unknown): EditEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  const rawStart = num(r.startMs, Number.NaN);
  const rawEnd = num(r.endMs, Number.NaN);
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawEnd < 0) return null;
  const startMs = Math.max(0, rawStart);
  let endMs = rawEnd;
  if (endMs < startMs) endMs = startMs;
  if (type === "cut") {
    const reason = r.reason === "privacy" || r.reason === "pause" ? r.reason : "rewind";
    const e: CutEdit = { type: "cut", startMs, endMs, reason };
    if (typeof r.label === "string") e.label = r.label;
    return e;
  }
  if (type === "speedup") {
    const t = Array.isArray(r.targetSecs) ? r.targetSecs : [3, 5];
    const lo = clamp(num(t[0], 3), 0.5, 60);
    const hi = clamp(num(t[1], 5), lo, 60);
    return {
      type: "speedup",
      startMs,
      endMs,
      targetSecs: [lo, hi],
      audio: r.audio === "mute" ? "mute" : "whoosh",
    };
  }
  if (type === "mask") {
    const reg = (r.region ?? {}) as Record<string, unknown>;
    const region: MaskRegion = {
      x: clamp(num(reg.x, 0), 0, 1),
      y: clamp(num(reg.y, 0), 0, 1),
      w: clamp(num(reg.w, 0.2), 0.005, 1),
      h: clamp(num(reg.h, 0.1), 0.005, 1),
    };
    const sources = ["match", "neighborhood", "region", "grace", "manual"];
    const drawnAt = num(r.drawnAtMs, Number.NaN);
    const e: MaskEdit = {
      type: "mask",
      startMs,
      endMs,
      region,
      style: r.style === "blur" ? "blur" : "black",
      muteAudio: r.muteAudio === true,
      startSource: sources.includes(String(r.startSource)) ? (r.startSource as MaskEdit["startSource"]) : "manual",
      pending: r.pending === true,
    };
    if (Number.isFinite(drawnAt)) e.drawnAtMs = Math.max(0, drawnAt);
    if (typeof r.refRegionHash === "string" && r.refRegionHash) e.refRegionHash = r.refRegionHash;
    if (typeof r.refPixels === "string" && r.refPixels) e.refPixels = r.refPixels;
    return e;
  }
  return null;
}

export function parseEdl(raw: unknown): EdlFile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (num(r.version, 0) !== 1) return null;
  const edits: EditEntry[] = Array.isArray(r.edits)
    ? r.edits.map(parseEdit).filter((e): e is EditEntry => e !== null)
    : [];
  return {
    version: 1,
    durationMs: typeof r.durationMs === "number" && Number.isFinite(r.durationMs) ? r.durationMs : null,
    finalized: r.finalized === true,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date(0).toISOString(),
    edits,
  };
}

// ---------------------------------------------------------------------------
// Appending / normalizing
// ---------------------------------------------------------------------------

const GRACE_MS = 1;

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  // Touching ranges (a.end == b.start) count as adjacent and merge — rewind
  // key presses in quick succession produce one continuous cut, not stutter.
  return aStart <= bEnd + GRACE_MS && bStart <= aEnd + GRACE_MS;
}

/**
 * Append an edit and normalize the list. Two cuts that overlap or touch merge
 * into one (a rewind pressed twice in a row extends the removed range). A
 * speedup or mask fully inside a cut is dropped (that footage is already gone).
 */
export function appendEdit(edl: EdlFile, edit: EditEntry): EdlFile {
  const parsed = parseEdit(edit);
  if (!parsed) return edl;
  const edits = normalizeEdits([...edl.edits, parsed]);
  return { ...edl, edits };
}

/** Sort by start time; merge overlapping/touching cuts; drop edits inside cuts. */
export function normalizeEdits(edits: EditEntry[]): EditEntry[] {
  const sorted = [...edits].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: EditEntry[] = [];
  for (const e of sorted) {
    if (e.type === "cut") {
      const last = out[out.length - 1];
      if (last && last.type === "cut" && rangesOverlap(last.startMs, last.endMs, e.startMs, e.endMs)) {
        last.endMs = Math.max(last.endMs, e.endMs);
        continue;
      }
      out.push({ ...e });
      continue;
    }
    // Non-cut edits inside a removed range are meaningless.
    const insideCut = out.some(
      (o) => o.type === "cut" && e.startMs >= o.startMs - GRACE_MS && e.endMs <= o.endMs + GRACE_MS,
    );
    if (insideCut) continue;
    // Merge with an identical-geometry neighbor of the same type.
    const last = out[out.length - 1];
    if (last && last.type === e.type && rangesOverlap(last.startMs, last.endMs, e.startMs, e.endMs)) {
      if (e.type === "speedup" && last.type === "speedup" &&
          last.audio === e.audio &&
          last.targetSecs[0] === e.targetSecs[0] && last.targetSecs[1] === e.targetSecs[1]) {
        last.endMs = Math.max(last.endMs, e.endMs);
        continue;
      }
      if (e.type === "mask" && last.type === "mask" &&
          last.style === e.style && last.muteAudio === e.muteAudio &&
          Math.abs(last.region.x - e.region.x) < 1e-6 && Math.abs(last.region.y - e.region.y) < 1e-6 &&
          Math.abs(last.region.w - e.region.w) < 1e-6 && Math.abs(last.region.h - e.region.h) < 1e-6) {
        last.endMs = Math.max(last.endMs, e.endMs);
        continue;
      }
    }
    out.push({ ...e });
  }
  return out;
}

/** Replace the edit at `index` (used by the timeline review UI). */
export function replaceEdit(edl: EdlFile, index: number, edit: EditEntry): EdlFile {
  if (index < 0 || index >= edl.edits.length) return edl;
  const parsed = parseEdit(edit);
  if (!parsed) return edl;
  const edits = [...edl.edits];
  edits[index] = parsed;
  return { ...edl, edits: normalizeEdits(edits) };
}

/**
 * The export-time privacy trim for one mask: everything between the content's
 * first visibility (startMs, backtraced — position-agnostic) and the moment
 * the mosaic covered it (drawnAtMs) is cut out of the film. The demo footage
 * before the content appeared stays, and the boxed region after drawnAtMs is
 * covered by the mosaic burn instead of being tracked.
 *
 * Returns null when there is nothing to cut (no drawn-at time recorded, e.g.
 * old EDLs, or an interval under `minMs`).
 */
export function privacyCutForMask(m: MaskEdit, minMs = 200): CutEdit | null {
  const t0 = Math.max(0, m.startMs);
  const t1 = Math.max(t0, m.drawnAtMs ?? m.startMs);
  if (t1 - t0 < minMs) return null;
  return { type: "cut", startMs: t0, endMs: t1, reason: "privacy" };
}

// ---------------------------------------------------------------------------
// Timeline computation (source -> output mapping)
// ---------------------------------------------------------------------------

/**
 * Walk the source timeline and produce output segments:
 *  - cut ranges are removed entirely;
 *  - speedup ranges are compressed to a clamped target duration;
 *  - everything else passes through at 1x.
 * `durationMs` bounds the walk (the live recording may not know it yet).
 */
export function buildTimeline(edl: EdlFile, durationMs: number): TimelineSegment[] {
  const total = Math.max(0, durationMs);
  const edits = normalizeEdits(edl.edits).filter((e) => e.endMs > 0);
  const segments: TimelineSegment[] = [];
  let src = 0;
  let out = 0;

  const pushKeep = (endMs: number) => {
    if (endMs - src <= 0) return;
    segments.push({ srcStartMs: src, srcEndMs: endMs, outStartMs: out, outEndMs: out + (endMs - src), speed: 1, via: "keep" });
    out += endMs - src;
    src = endMs;
  };

  for (const e of edits) {
    if (e.startMs >= total) break;
    const end = Math.min(e.endMs, total);
    if (end <= src) continue;
    if (e.type === "cut") {
      pushKeep(Math.min(e.startMs, total));
      src = end; // drop the removed range
      continue;
    }
    // Non-cut edits can start inside the still-open "keep" window.
    pushKeep(Math.min(e.startMs, total));
    const srcLen = end - src;
    if (srcLen <= 0) continue;
    if (e.type === "speedup") {
      const targetMs = clamp(srcLen / 1000, e.targetSecs[0], e.targetSecs[1]) * 1000;
      segments.push({ srcStartMs: src, srcEndMs: end, outStartMs: out, outEndMs: out + targetMs, speed: srcLen / targetMs, via: e });
      out += targetMs;
    } else {
      // Mask: time passes through unchanged.
      segments.push({ srcStartMs: src, srcEndMs: end, outStartMs: out, outEndMs: out + srcLen, speed: 1, via: "keep" });
      out += srcLen;
    }
    src = end;
  }
  pushKeep(total);
  return segments;
}

/** Map a source timestamp to the output timeline (ignores pending masks' future). */
export function sourceToOutputMs(segments: TimelineSegment[], srcMs: number): number {
  for (const s of segments) {
    if (srcMs < s.srcEndMs || (srcMs === s.srcEndMs && s.srcStartMs === s.srcEndMs)) {
      const within = clamp(srcMs - s.srcStartMs, 0, s.srcEndMs - s.srcStartMs);
      return s.outStartMs + within / s.speed;
    }
  }
  const last = segments[segments.length - 1];
  return last ? last.outEndMs : 0;
}

/** Map an output timestamp back to source time (inverse of sourceToOutputMs). */
export function outputToSourceMs(segments: TimelineSegment[], outMs: number): number {
  for (const s of segments) {
    if (outMs < s.outEndMs || (outMs === s.outEndMs && s.outStartMs === s.outEndMs)) {
      const within = clamp(outMs - s.outStartMs, 0, s.outEndMs - s.outStartMs);
      return s.srcStartMs + within * s.speed;
    }
  }
  const last = segments[segments.length - 1];
  return last ? last.srcEndMs : 0;
}

/** Summary numbers for the export report / timeline legend. */
export function edlReport(edl: EdlFile, durationMs: number): EdlReport {
  const edits = normalizeEdits(edl.edits);
  const cuts = edits.filter((e): e is CutEdit => e.type === "cut");
  const masks = edits.filter((e): e is MaskEdit => e.type === "mask");
  const speedups = edits.filter((e): e is SpeedupEdit => e.type === "speedup");
  const segments = buildTimeline(edl, durationMs);
  const outputDurationMs = segments.length ? segments[segments.length - 1].outEndMs : 0;
  return {
    cuts: { count: cuts.length, totalMs: cuts.reduce((a, c) => a + (c.endMs - c.startMs), 0) },
    masks: { count: masks.length, totalMs: masks.reduce((a, m) => a + (m.endMs - m.startMs), 0) },
    speedups: {
      count: speedups.length,
      sourceMs: speedups.reduce((a, s) => a + (s.endMs - s.startMs), 0),
      outputMs: outputDurationMs
        ? speedups.reduce((a, s) => {
            const seg = segments.find((g) => g.via !== "keep" && g.srcStartMs === s.startMs);
            return a + (seg ? seg.outEndMs - seg.outStartMs : 0);
          }, 0)
        : 0,
    },
    sourceDurationMs: durationMs,
    outputDurationMs,
  };
}

/** Formats ms as h:mm:ss (timeline labels). */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}
