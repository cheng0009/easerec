/**
 * Privacy backtrace scanner. Runs ffmpeg over the (partial, still-growing)
 * recording and pipes small grayscale frames out, scoring each frame against
 * the mask reference (region content + neighborhood + full-frame context) to
 * locate the FIRST appearance of the sensitive content — the automatic mask
 * start that replaces time estimation. The region signal is POSITION-AGNOSTIC
 * (best match across a grid of candidate spots), so a first appearance that
 * happened at another screen position is still found; the export cuts the
 * pre-box window it defines.
 *
 * The scoring/ladder logic is in src/lib/perceptualHash.ts (pure, tested);
 * this file is the ffmpeg plumbing around it.
 */

import { spawn } from "node:child_process";
import { cropResize, dHash, decodeGrayPixels, hashFromHex, resolveBacktraceStart, regionSearchCandidates, extendBacktraceForDynamicEntrance, type BacktraceMethod, type BacktraceThresholds, type FrameScores } from "../src/lib/perceptualHash";
import type { MaskRegion } from "../src/recording/edl";

// Extraction geometry: 16:9-ish downscale keeps text gradients alive while
// keeping per-frame compute trivial (256*144 = 36,864 gray bytes).
const SCAN_W = 256;
const SCAN_H = 144;

export interface BacktraceRequest {
  webmPath: string;
  ffmpegPath: string;
  /** Normalized mask rectangle (0..1 of the captured frame). */
  region: MaskRegion;
  /** Reference hashes captured at mask time (hex from the renderer). */
  refRegionHash: string;
  refFrameHash: string;
  /** Optional 16x16 grayscale hex of the boxed region (NCC/brightness crutch).
   *  When the reference is a solid uniform block (flat banner/logo) the
   *  dHash-only region lane matches ANY flat area at any time (sim 1.0) and
   *  drags startMs to 0; with pixels present we enforce mean-brightness
   *  proximity on flat pairs, like the occurrence scanner does. */
  refPixels?: string;
  /** Scan fps and timeout. */
  fps?: number;
  timeoutMs?: number;
  /** Content match thresholds for the ladder. Defaults are tuned for live
   *  sampling; override them when reference and scan use different pipelines. */
  thresholds?: BacktraceThresholds;
  /** The content often appears DYNAMIC (slides/fades/pops over several
   *  positions) before settling; only then does the user box it. From the
   *  static first-match we walk backward across the moving/partial frames up
   *  to this many ms to also cover the dynamic reveal. */
  dynamicEntranceMs?: number;
}

export interface BacktraceResult {
  /** Found start (ms) and the ladder step that accepted it, or null. */
  startMs: number | null;
  method: BacktraceMethod | null;
  framesScanned: number;
  error?: string;
}

/**
 * Scan the recording. Frames arrive chronologically; we score every frame and
 * let resolveBacktraceStart apply the ladder over the full timeline (full
 * joint match anywhere wins over earlier looser matches — see its tests).
 */
export function scanBacktrace(req: BacktraceRequest): Promise<BacktraceResult> {
  const fps = req.fps ?? 2;
  const args = [
    "-an", "-sn",
    "-i", req.webmPath,
    "-vf", `fps=${fps},scale=${SCAN_W}:${SCAN_H}:flags=area`,
    "-pix_fmt", "gray",
    "-f", "rawvideo",
    "-",
  ];
  const frameBytes = SCAN_W * SCAN_H;
  const refRegion = hashFromHex(req.refRegionHash);
  const refFrame = hashFromHex(req.refFrameHash);
  const refPx = req.refPixels ? decodeGrayPixels(req.refPixels, 16) : null;
  const refPxUniform = !!refPx && !hasVariance(refPx);
  const refPxMean = refPx ? meanOf(refPx) : 0;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(req.ffmpegPath, args, { windowsHide: true });
    } catch (e) {
      resolve({ startMs: null, method: null, framesScanned: 0, error: String(e) });
      return;
    }

    let buf = Buffer.alloc(0);
    const scores: FrameScores[] = [];
    // Motion in the band region between consecutive scan frames — the SIGNAL
    // that the content was still dynamic on its way to where the user boxed it.
    const cropDiffs: number[] = [];
    let prevCrop: Uint8Array | null = null;
    let stderrTail = "";
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, req.timeoutMs ?? 120_000);

    const neighborhood = {
      x: Math.max(0, req.region.x - req.region.w * 1.5),
      y: Math.max(0, req.region.y - req.region.h * 1.5),
      w: Math.min(1, req.region.w * 4),
      h: Math.min(1, req.region.h * 4),
    };
    // Position-agnostic region search: the content may have sat at a DIFFERENT
    // screen position earlier (scrolled / window moved), so score the drawn box
    // AND a grid of nearby + full-frame candidate spots and take the best. This
    // finds the true first appearance, which the export cuts pre-box.
    const candidates = regionSearchCandidates(req.region);

    const consume = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= frameBytes) {
        const frame = { data: new Uint8Array(buf.subarray(0, frameBytes)), width: SCAN_W, height: SCAN_H };
        buf = buf.subarray(frameBytes);
        let region = -1;
        for (const r of candidates) {
          const crop = cropResize(frame, r, 16);
          const s = sim(dHash(crop, 8), refRegion);
          if (refPx && (refPxUniform || !hasVariance(crop.data))) {
            if (Math.abs(refPxMean - meanOf(crop.data)) > 45) continue;
          }
          region = Math.max(region, s);
        }
        scores.push({
          region,
          neighborhood: sim(dHash(cropResize(frame, neighborhood, 16), 8), refRegion),
          frame: sim(dHash(frame, 8), refFrame),
        });
        // Band crop inter-frame difference (mean abs pixel delta over the
        // 16x16 neighborhood resample) — the dynamic-entrance motion signal.
        const crop = cropResize(frame, neighborhood, 16).data;
        if (prevCrop) {
          let sum = 0;
          for (let i = 0; i < crop.length; i++) sum += Math.abs(crop[i] - prevCrop[i]);
          cropDiffs.push(sum / crop.length);
        } else {
          cropDiffs.push(0);
        }
        prevCrop = crop;
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
      resolve({ startMs: null, method: null, framesScanned: scores.length, error: String(e) });
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const res = scores.length ? resolveBacktraceStart(scores, req.thresholds) : null;
      // Dynamic-entrance extension: content often slides/fades into place BEFORE
      // it settles and matches the static reference. Extend the start backward
      // across partial matches and band motion so the pre-box cut also removes
      // the dynamic reveal (which would otherwise leak unmosaicked).
      let index = res ? res.index : -1;
      let method: BacktraceMethod | null = res ? res.method : null;
      if (index >= 0) {
        const cap = Math.max(0, Math.round(((req.dynamicEntranceMs ?? 5000) * fps) / 1000));
        const extended = extendBacktraceForDynamicEntrance(scores, cropDiffs, { startIndex: index, maxExtendFrames: cap });
        if (extended < index) {
          index = extended;
          method = "dynamic";
        }
      }
      resolve({
        startMs: index >= 0 ? Math.round((index * 1000) / fps) : null,
        method,
        framesScanned: scores.length,
        error: index >= 0 ? undefined : `no match (${stderrTail.slice(-160)})`,
      });
    });
  });
}

function sim(a: { lo: number; hi: number }, b: { lo: number; hi: number }): number {
  let d = 0;
  let x = (a.lo ^ b.lo) >>> 0;
  while (x) { d += x & 1; x >>>= 1; }
  x = (a.hi ^ b.hi) >>> 0;
  while (x) { d += x & 1; x >>>= 1; }
  return 1 - d / 64;
}

function meanOf(px: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < px.length; i++) s += px[i];
  return s / px.length;
}

function hasVariance(px: Uint8Array): boolean {
  const m = px[0];
  for (let i = 1; i < px.length; i++) if (px[i] !== m) return true;
  return false;
}
