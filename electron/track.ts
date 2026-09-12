/**
 * Export-time occurrence scanner. Rewinds the final recording and finds EVERY
 * appearance of the masked content (e.g. the text "不着急") wherever it sits on
 * screen — not just inside the drawn box. Because the content's position is
 * determined by the page/window layout (it never teleports randomly), the
 * detection searches a bounded band around the drawn position and confirms
 * each candidate with dHash + cross-correlation (see detectFrameOccurrences).
 *
 * The scanner is pure ffmpeg plumbing; the matching logic lives in
 * src/lib/perceptualHash.ts (tested). Runs are returned in the same order as
 * the mask edits so the export planner can turn them into extra mosaic areas.
 */

import { spawn } from "node:child_process";
import { detectFrameOccurrences, mergeOccurrenceRuns, hashFromHex, type OccurrenceRun, type OccurrenceSample } from "../src/lib/perceptualHash";
import type { MaskRegion } from "../src/recording/edl";

const SCAN_W = 256;
const SCAN_H = 144;

export interface OccMaskInput {
  /** Mask region (capture-normalized 0..1). */
  region: MaskRegion;
  /** Region fingerprint captured at mask time (hex dHash). */
  refRegionHash: string;
  /** 16x16 grayscale template (hex) for cross-correlation. */
  refPixels?: string;
}

export interface OccScanRequest {
  inputPath: string;
  ffmpegPath: string;
  /** Recording duration in ms (clamps a trailing partial frame). */
  durationMs: number;
  /** Masks to look for — parallel order with the result. */
  masks: OccMaskInput[];
  /** Frame rate of the scan. */
  fps?: number;
  timeoutMs?: number;
  /** Detection gates. Defaults favor recall but stay strict enough to avoid
   *  solid blocks of background matching a solid template. */
  dHashMin?: number;
  nccMin?: number | null;
  coarseStride?: number | null;
  maxHits?: number;
  runGapMs?: number;
}

export interface OccScanResult {
  /** Per-mask occurrence runs (aligned with `masks`); empty list = none. */
  runs: OccurrenceRun[][];
  framesScanned: number;
  error?: string;
}

/**
 * Scan the whole video for content matches of every mask and merge the hits
 * into time runs. Masks without a stored fingerprint are skipped (empty run
 * list) rather than failing the export.
 */
export function scanPrivacyOccurrences(req: OccScanRequest): Promise<OccScanResult> {
  const active = req.masks
    .map((m) => ({ region: m.region, hash: hashFromHex(m.refRegionHash), pixels: m.refPixels || "" }))
    .filter((m) => m.hash.lo !== 0 || m.hash.hi !== 0);

  // Nothing to look for: return empty runs without touching ffmpeg.
  if (active.length === 0) {
    return Promise.resolve({ runs: req.masks.map(() => []), framesScanned: 0 });
  }

  const fps = req.fps ?? 10;
  const frameMs = 1000 / fps;
  const args = [
    "-an", "-sn",
    "-i", req.inputPath,
    "-vf", `fps=${fps},scale=${SCAN_W}:${SCAN_H}:flags=area`,
    "-pix_fmt", "gray",
    "-f", "rawvideo",
    "-",
  ];
  const frameBytes = SCAN_W * SCAN_H;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(req.ffmpegPath, args, { windowsHide: true });
    } catch (e) {
      resolve({ runs: req.masks.map(() => []), framesScanned: 0, error: String(e) });
      return;
    }

    let buf = Buffer.alloc(0);
    const samples: OccurrenceSample[][] = active.map(() => []);
    let framesScanned = 0;
    let stderrTail = "";
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, req.timeoutMs ?? 180_000);

    const consume = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= frameBytes) {
        const frame = { data: new Uint8Array(buf.subarray(0, frameBytes)), width: SCAN_W, height: SCAN_H };
        buf = buf.subarray(frameBytes);
        const tMs = framesScanned * frameMs;
        if (tMs > req.durationMs + frameMs) continue;
        for (let i = 0; i < active.length; i++) {
          const a = active[i];
          const hits = detectFrameOccurrences(frame, a.region, a.hash, a.pixels, {
            dHashMin: req.dHashMin ?? 0.78,
            nccMin: req.nccMin ?? 0.22,
            coarseStride: req.coarseStride ?? 32,
            refinePx: 2,
            maxHits: req.maxHits ?? 8,
          });
          for (const h of hits) samples[i].push({ tMs, rect: h.rect, sim: h.sim });
        }
        framesScanned++;
      }
    };

    child.stdout?.on("data", (d: Buffer) => consume(d));
    child.stderr?.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).split("\n").slice(-4).join("\n");
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ runs: req.masks.map(() => []), framesScanned, error: String(e) });
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const runs = samples.map((s) => mergeOccurrenceRuns(s, { runGapMs: req.runGapMs ?? 1000, cellBits: 7 }));
      resolve({
        runs,
        framesScanned,
        error: framesScanned === 0 ? `no frames decoded (${stderrTail.slice(-160)})` : undefined,
      });
    });
  });
}