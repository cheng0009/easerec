/**
 * FilmStrip layout — the "成片" metaphor timeline. Pure geometry/summary math:
 *
 *   [片头 intro] [ 主片 main (marks as chips) ] [片尾 outro]
 *
 * The main segment width dominates (min 50%) so long recordings stay legible;
 * attached intro/outro get proportional slices of the remainder.
 */

import type { EditEntry } from "../recording/edl";

export interface FilmSeg {
  kind: "intro" | "main" | "outro";
  /** percent width 0-100 (sums to 100). */
  width: number;
  /** attached file duration in ms (0 = empty slot). */
  attachMs: number;
}

export interface FilmLayout {
  segs: FilmSeg[];
  /** Projected final duration: intro + output(main) + outro. */
  outputMs: number;
}

export function filmStripLayout(
  mainDurationMs: number,
  _edits: EditEntry[],
  introMs: number,
  outroMs: number,
  outputMainMs: number,
): FilmLayout {
  const d = Math.max(0, mainDurationMs);
  const hasIntro = introMs > 0;
  const hasOutro = outroMs > 0;
  // Main keeps at least half the strip; ends split the rest proportionally
  // to their attach durations (empty slots show as slim stubs).
  const mainW = d > 0 ? 62 : 50;
  const rest = 100 - mainW;
  const total = (hasIntro ? introMs : 0) + (hasOutro ? outroMs : 0);
  const introW = hasIntro ? (rest * introMs) / Math.max(1, total) : rest / (hasOutro ? 6 : 3);
  const outroW = hasOutro ? (rest * outroMs) / Math.max(1, total) : rest / (hasIntro ? 6 : 3);
  // Normalize rounding.
  const sum = introW + mainW + outroW;
  return {
    segs: [
      { kind: "intro", width: (introW / sum) * 100, attachMs: introMs },
      { kind: "main", width: (mainW / sum) * 100, attachMs: 0 },
      { kind: "outro", width: (outroW / sum) * 100, attachMs: outroMs },
    ],
    outputMs: (hasIntro ? introMs : 0) + Math.max(0, outputMainMs) + (hasOutro ? outroMs : 0),
  };
}

/** Map a click position (0-1 across the whole strip) to main-film time (ms).
 *  Clicks on intro/outro slots map to 0 / end respectively. */
export function stripPosToMainMs(
  pos: number,
  layout: FilmLayout,
  mainDurationMs: number,
): number {
  let acc = 0;
  for (const seg of layout.segs) {
    const w = seg.width / 100;
    if (pos < acc + w) {
      if (seg.kind !== "main") return seg.kind === "outro" ? mainDurationMs : 0;
      const local = (pos - acc) / w;
      return Math.max(0, Math.min(mainDurationMs, local * mainDurationMs));
    }
    acc += w;
  }
  return mainDurationMs;
}

/** Inverse: main-film time (ms) -> strip position (0-1), clamped to main seg. */
export function mainMsToStripPos(ms: number, layout: FilmLayout, mainDurationMs: number): number {
  const intro = layout.segs.find((s) => s.kind === "intro");
  const main = layout.segs.find((s) => s.kind === "main");
  const introW = (intro?.width ?? 0) / 100;
  const mainW = (main?.width ?? 100) / 100;
  const local = mainDurationMs > 0 ? Math.max(0, Math.min(1, ms / mainDurationMs)) : 0;
  return introW + local * mainW;
}

export interface MarkSummary {
  cuts: number;
  masks: number;
  speedups: number;
  pauses: number;
  /** True when any mask is still open (box on screen) or the backtrace is pending. */
  active: boolean;
}

/** Human-facing mark totals for the review bar / status badges. */
export function summarizeMarks(edits: EditEntry[], opts: { activePrivacy?: boolean; activeFF?: boolean; activePause?: boolean; activePrivacyCut?: boolean } = {}): MarkSummary {
  const cuts = edits.filter((e) => e.type === "cut");
  return {
    cuts: cuts.filter((e) => e.reason !== "pause").length,
    masks: edits.filter((e) => e.type === "mask").length,
    speedups: edits.filter((e) => e.type === "speedup").length,
    pauses: cuts.filter((e) => e.reason === "pause").length,
    active: !!(opts.activePrivacy || opts.activeFF || opts.activePause || opts.activePrivacyCut),
  };
}
