import { describe, expect, it } from "vitest";
import {
  cropResize,
  dHash,
  detectFrameOccurrences,
  encodeGrayPixels,
  extendBacktraceForDynamicEntrance,
  findFirstJointMatch,
  hashFromHex,
  hashSimilarity,
  hashToHex,
  mergeOccurrenceRuns,
  normalizedCorrelation,
  refFromFrame,
  regionSearchCandidates,
  resolveBacktraceStart,
  type FrameScores,
  type GrayFrame,
} from "./perceptualHash";

function solidFrame(w: number, h: number, v: number): GrayFrame {
  return { data: new Uint8Array(w * h).fill(v), width: w, height: h };
}

/** Vertical "terminal text" bars: brightness sequence derived from the seed. */
function drawBars(f: GrayFrame, rect: { x: number; y: number; w: number; h: number }, seed: number, bars = 24): void {
  const x0 = Math.round(rect.x * f.width);
  const x1 = Math.round((rect.x + rect.w) * f.width);
  const y0 = Math.round(rect.y * f.height);
  const y1 = Math.round((rect.y + rect.h) * f.height);
  for (let b = x0; b < x1; b++) {
    const t = (b - x0) / Math.max(1, x1 - x0);
    const v = (((Math.floor(t * bars) * 7 + seed * 13) % 4) * 60) + 20;
    for (let y = y0; y < y1; y++) f.data[y * f.width + b] = v;
  }
}

/** A synthetic "page": bar pattern filling the whole frame. */
function page(seed: number, w = 256, h = 144): GrayFrame {
  const f = solidFrame(w, h, 30);
  drawBars(f, { x: 0, y: 0, w: 1, h: 1 }, seed);
  return f;
}

/** Draws a bright rectangle (a "notification") somewhere on the frame. */
function withBanner(f: GrayFrame, bx: number, by: number, bw: number, bh: number): GrayFrame {
  const out = { data: new Uint8Array(f.data), width: f.width, height: f.height };
  for (let y = by; y < by + bh && y < out.height; y++)
    for (let x = bx; x < bx + bw && x < out.width; x++) out.data[y * out.width + x] = 230;
  return out;
}

const REGION = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };

describe("dHash basics", () => {
  it("identical frames have similarity 1", () => {
    expect(hashSimilarity(dHash(page(1)), dHash(page(1)))).toBe(1);
  });

  it("a monotonic gradient frame is stable regardless of brightness level", () => {
    // dHash only compares neighbor gradients: uniform brightness shifts cancel.
    const g = (v: number): GrayFrame => {
      const f = solidFrame(64, 64, 0);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) f.data[y * 64 + x] = x * 2 + v;
      return f;
    };
    expect(hashSimilarity(dHash(g(0)), dHash(g(40)))).toBe(1);
  });

  it("different content hashes differently", () => {
    expect(hashSimilarity(dHash(page(1)), dHash(page(99)))).toBeLessThan(0.9);
  });

  it("a small banner (cursor/noise scale) barely moves the hash", () => {
    const base = page(1);
    const noisy = withBanner(base, 120, 68, 6, 4);
    expect(hashSimilarity(dHash(base), dHash(noisy))).toBeGreaterThan(0.95);
  });

  it("hex round-trips", () => {
    const h = dHash(page(3));
    expect(hashFromHex(hashToHex(h))).toEqual(h);
  });
});

describe("cropResize", () => {
  it("extracts the requested normalized region", () => {
    const f = solidFrame(100, 100, 0);
    // Right half bright, left half dark.
    for (let y = 0; y < 100; y++) for (let x = 50; x < 100; x++) f.data[y * 100 + x] = 200;
    const crop = cropResize(f, { x: 0.5, y: 0, w: 0.5, h: 1 }, 4);
    expect(crop.width).toBe(4);
    expect(crop.data.every((v) => v === 200)).toBe(true);
    const left = cropResize(f, { x: 0, y: 0, w: 0.5, h: 1 }, 4);
    expect(left.data.every((v) => v === 0)).toBe(true);
  });

  it("clamps out-of-bounds regions", () => {
    const f = solidFrame(10, 10, 7);
    const crop = cropResize(f, { x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 4);
    expect(crop.data.every((v) => v === 7)).toBe(true);
  });
});

describe("regionSearchCandidates", () => {
  const reg = { x: 0.5, y: 0.4, w: 0.2, h: 0.1 };

  it("includes the drawn box itself (deduplicated)", () => {
    const c = regionSearchCandidates(reg);
    expect(c.filter((r) => r.x === reg.x && r.y === reg.y)).toHaveLength(1);
  });

  it("adds a local 3x3 offset grid around the box", () => {
    const c = regionSearchCandidates(reg);
    expect(c.some((r) => Math.abs(r.x - (0.5 - 0.2)) < 1e-6 && Math.abs(r.y - (0.4 + 0.1)) < 1e-6)).toBe(true);
  });

  it("adds a coarse full-frame grid (content could have been anywhere earlier)", () => {
    const c = regionSearchCandidates(reg);
    expect(c.some((r) => Math.abs(r.x) < 1e-6 && Math.abs(r.y) < 1e-6)).toBe(true);
    expect(c.some((r) => Math.abs(r.x - 2 / 3) < 1e-6 && Math.abs(r.y - 0.5) < 1e-6)).toBe(true);
    // every candidate keeps the drawn size so identical content matches at
    // any scale-consistent position
    expect(c.every((r) => r.w === reg.w && r.h === reg.h)).toBe(true);
  });
});

describe("findFirstJointMatch", () => {
  it("finds the earliest frame where BOTH region and frame match", () => {
    // Frames 0-4: old page. Frame 5: the page with sensitive content appears.
    const frames = [page(1), page(1), page(1), page(1), page(1), page(2), page(2), page(2)];
    const refRegion = dHash(cropResize(page(2), REGION, 16), 8);
    const refFrame = dHash(page(2), 8);
    const res = findFirstJointMatch(
      frames.map((f) => dHash(f, 8)),
      frames.map((f) => dHash(cropResize(f, REGION, 16), 8)),
      { region: refRegion, frame: refFrame },
    );
    expect(res).not.toBeNull();
    expect(res!.index).toBe(5);
  });

  it("rejects an earlier lookalike region on a DIFFERENT page (context anchor)", () => {
    // pageB carries the same region content but a different page background —
    // region-only matching would wrongly anchor there; the joint rule must not.
    const pageB = solidFrame(256, 144, 30);
    drawBars(pageB, REGION, 2);
    drawBars(pageB, { x: 0, y: 0, w: 1, h: 0.28 }, 90);
    drawBars(pageB, { x: 0, y: 0.72, w: 1, h: 0.28 }, 77);
    const pageC = solidFrame(256, 144, 30);
    drawBars(pageC, REGION, 2);
    drawBars(pageC, { x: 0, y: 0, w: 1, h: 0.28 }, 41);
    drawBars(pageC, { x: 0, y: 0.72, w: 1, h: 0.28 }, 63);
    const unrelated = page(1);
    const frames = [unrelated, unrelated, pageB, unrelated, pageC, pageC];
    const res = findFirstJointMatch(
      frames.map((f) => dHash(f, 8)),
      frames.map((f) => dHash(cropResize(f, REGION, 16), 8)),
      { region: dHash(cropResize(pageC, REGION, 16), 8), frame: dHash(pageC, 8) },
    );
    expect(res).not.toBeNull();
    expect(res!.index).toBe(4);
  });

  it("returns null when the content never appears", () => {
    const ref = page(1);
    const other = page(7);
    const res = findFirstJointMatch(
      [other, other, other].map((f) => dHash(f, 8)),
      [other, other, other].map((f) => dHash(cropResize(f, REGION, 16), 8)),
      { region: dHash(cropResize(ref, REGION, 16), 8), frame: dHash(ref, 8) },
    );
    expect(res!.index).toBe(-1);
  });

  it("tolerates small frame noise around the true appearance", () => {
    const before = page(1);
    const appear = page(2);
    const appearNoisy = withBanner(page(2), 100, 60, 5, 3); // cursor moved
    const frames = [before, before, appear, appearNoisy, appearNoisy];
    const res = findFirstJointMatch(
      frames.map((f) => dHash(f, 8)),
      frames.map((f) => dHash(cropResize(f, REGION, 16), 8)),
      { region: dHash(cropResize(appear, REGION, 16), 8), frame: dHash(appear, 8) },
    );
    expect(res).not.toBeNull();
    expect(res!.index).toBe(2);
  });
});

describe("resolveBacktraceStart ladder", () => {
  const scores = (rows: [number, number, number][]): FrameScores[] =>
    rows.map(([region, neighborhood, frame]) => ({ region, neighborhood, frame }));

  it("prefers a full joint match over earlier region-only hits", () => {
    const s = scores([
      [0.95, 0.60, 0.50], // region-only lookalike (wrong page)
      [0.50, 0.55, 0.50],
      [0.95, 0.90, 0.90], // true first appearance
      [0.95, 0.90, 0.90],
    ]);
    expect(resolveBacktraceStart(s)).toEqual({ index: 2, method: "match" });
  });

  it("falls back to neighborhood context when the full frame never clears", () => {
    const s = scores([
      [0.50, 0.50, 0.50],
      [0.92, 0.90, 0.60], // other-monitor animation drags full-frame down
      [0.92, 0.90, 0.60],
    ]);
    expect(resolveBacktraceStart(s)).toEqual({ index: 1, method: "neighborhood" });
  });

  it("falls back to strict region-only and flags for review", () => {
    const s = scores([
      [0.60, 0.60, 0.60],
      [0.93, 0.70, 0.65],
    ]);
    const res = resolveBacktraceStart(s);
    expect(res).toEqual({ index: 1, method: "region" });
  });

  it("returns null when nothing matches (grace-window fallback)", () => {
    const s = scores([
      [0.60, 0.60, 0.60],
      [0.70, 0.65, 0.60],
    ]);
    expect(resolveBacktraceStart(s)).toBeNull();
  });

  it("never steps DOWN the ladder: joint match wins even if neighborhood matched earlier", () => {
    // Frame 0 matches region+neighborhood but not the full frame; frame 2
    // matches everything. The full-frame step runs across ALL frames first,
    // so the answer is frame 2 with "match", not frame 0.
    const s = scores([
      [0.95, 0.92, 0.60],
      [0.95, 0.92, 0.60],
      [0.95, 0.92, 0.90],
    ]);
    expect(resolveBacktraceStart(s)).toEqual({ index: 2, method: "match" });
  });
});

describe("extendBacktraceForDynamicEntrance", () => {
  const scoresOf = (region: number, n: number): FrameScores[] =>
    Array.from({ length: n }, () => ({ region, neighborhood: region, frame: region }));

  it("walks back across partial matches while the region still holds", () => {
    // Frames 5..15 show the content (partially) at/near the box; earlier is quiet.
    const s = [
      ...scoresOf(0.3, 5), // quiet lead-in
      ...scoresOf(0.9, 11), // dynamic arrival (partial) then settle
    ];
    const diffs = s.map((_, i) => (i >= 5 ? 22 : 3));
    expect(extendBacktraceForDynamicEntrance(s, diffs, { startIndex: 15 })).toBe(5);
  });

  it("walks back across MOVEMENT even when the region is below the soft gate", () => {
    // The content slides in: region score stays low (still off the box) but the
    // band keeps moving until it drops into place at frame 8.
    const s = [
      ...scoresOf(0.2, 3), // quiet (idx 0..2)
      ...scoresOf(0.45, 5), // still sliding (idx 3..7, region < 0.6)
      ...scoresOf(0.95, 8), // settled
    ];
    const diffs = s.map((_, i) => (i >= 3 && i < 8 ? 31 : 4));
    expect(extendBacktraceForDynamicEntrance(s, diffs, { startIndex: 15 })).toBe(3);
  });

  it("stops at the first quiet frame and keeps motion covered up to the cap", () => {
    // Content arrives at frame 30 (motion on) and matches from frame 10 on;
    // frames 0..9 are genuinely quiet (no region match, no motion).
    const s = [
      ...scoresOf(0.3, 10), // quiet lead-in (idx 0..9)
      ...scoresOf(0.9, 40), // visible (idx 10..49)
    ];
    const diffs = s.map((_, i) => (i >= 30 ? 25 : 3));
    // Cap bounds the walk even though motion is continuous from frame 30.
    expect(extendBacktraceForDynamicEntrance(s, diffs, { startIndex: 49, maxExtendFrames: 10 })).toBe(39);
    // Without a cap it reaches the first quiet frame.
    expect(extendBacktraceForDynamicEntrance(s, diffs, { startIndex: 49 })).toBe(10);
  });
});

describe("detectFrameOccurrences", () => {
  const W = 256;
  const H = 144;
  const box = { x: 0.5, y: 0.5, w: 0.2, h: 0.1 };
  const refPixelsHex = (): string => {
    const crop = cropResize(withBanner(solidFrame(W, H, 30), 128, 72, 51, 14), box, 16);
    let hex = "";
    for (const v of crop.data) hex += v.toString(16).padStart(2, "0");
    return hex;
  };
  const refHash = dHash(cropResize(withBanner(solidFrame(W, H, 30), 128, 72, 51, 14), box, 16), 8);

  it("finds the content at a different spot and NOT in random noise", () => {
    // Same pattern drawn at (0.05, 0.3) — the typical "scrolled elsewhere".
    const f = solidFrame(W, H, 30);
    drawBars(f, { x: 0.5, y: 0.5, w: 0.2, h: 0.1 }, 2);
    const target = withBanner(f, 13, 43, 51, 14);
    const hits = detectFrameOccurrences(target, box, refHash, refPixelsHex());
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const r = hits[0].rect;
    expect(Math.abs(r.x - 13 / W)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(r.y - 43 / H)).toBeLessThanOrEqual(0.05);
  });

  it("returns no hits on an unrelated frame", () => {
    const f = page(5); // completely different bar pattern
    expect(detectFrameOccurrences(f, box, refHash)).toEqual([]);
  });

  it("rejects a brightness-boosted frame when the NCC gate is enabled", () => {
    const refHashFixed = refHash;
    // Reference template pixels (hex) from the same crop that produced refHash.
    const crop = cropResize(withBanner(solidFrame(W, H, 30), 128, 72, 51, 14), box, 16);
    let hex = "";
    for (const v of crop.data) hex += v.toString(16).padStart(2, "0");
    const f = withBanner(solidFrame(W, H, 30), 13, 43, 51, 14);
    // NCC >= 0.3 required — this frame's banner IS the same pattern, so it hits.
    expect(detectFrameOccurrences(f, box, refHashFixed, hex).length).toBeGreaterThanOrEqual(1);
    // And a different pattern fails both gates.
    expect(detectFrameOccurrences(page(5), box, refHashFixed, hex)).toEqual([]);
  });

  it("sub-grid refinement pins a hit that lands off the scan grid", () => {
    // Banner drawn at an x/y that is NOT a multiple of the slide step. Without
    // refinement the mosaic would snap to a half-step (the "偏下" symptom); the
    // refine pass must converge within a couple of scan pixels instead.
    const f = withBanner(solidFrame(W, H, 30), 130, 41, 51, 14);
    const calls = detectFrameOccurrences(f, box, refHash, refPixelsHex(), { refinePx: 2 });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(calls[0].rect.x * W - 130)).toBeLessThanOrEqual(2);
    expect(Math.abs(calls[0].rect.y * H - 41)).toBeLessThanOrEqual(2);
  });

  it("coarse whole-frame net catches occurrences far off the relative band", () => {
    // Box sits low; the banner sits in the opposite corner, outside the band.
    // Only the coarse net can reach it; the band-only scan must find nothing.
    const cornerBox = { x: 0.55, y: 0.6, w: 0.2, h: 0.1 };
    const bxx = Math.round(cornerBox.x * W);
    const byy = Math.round(cornerBox.y * H);
    const refFrame = withBanner(solidFrame(W, H, 30), bxx, byy, 51, 14);
    const refH = dHash(cropResize(refFrame, cornerBox, 16), 8);
    let hex = "";
    for (const v of cropResize(refFrame, cornerBox, 16).data) hex += v.toString(16).padStart(2, "0");
    const target = withBanner(solidFrame(W, H, 30), 0, 0, 48, 12);
    expect(detectFrameOccurrences(target, cornerBox, refH, hex, { coarseStride: null })).toEqual([]);
    const hits = detectFrameOccurrences(target, cornerBox, refH, hex, { coarseStride: 32, refinePx: 2 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // rect stores the CORNER; position the center of the found box.
    expect(Math.abs((hits[0].rect.x + hits[0].rect.w / 2) * W - 24)).toBeLessThanOrEqual(3);
    expect(Math.abs((hits[0].rect.y + hits[0].rect.h / 2) * H - 6)).toBeLessThanOrEqual(3);
  });
});

describe("refFromFrame (scan-canonical reference)", () => {
  const W = 256;
  const H = 144;
  const box = { x: 0.5, y: 0.5, w: 0.2, h: 0.1 };

  it("a reference re-derived from the scan pipeline detects the drawn spot", () => {
    // This mirrors the export path: instead of trusting a full-res live sample,
    // the fingerprint is recomputed from a scan-resolution frame (area-scale),
    // so the same pipeline that scans also defined the reference.
    const f = withBanner(solidFrame(W, H, 30), 128, 72, 51, 14);
    const { refRegionHash, refPixels } = refFromFrame(f, box);
    expect(encodeGrayPixels(cropResize(f, box, 16))).toBe(refPixels);
    const same = withBanner(solidFrame(W, H, 30), 128, 72, 51, 14);
    const hits = detectFrameOccurrences(same, box, hashFromHex(refRegionHash), refPixels);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // A moved occurrence is found too (the F6-pre window scenario).
    const moved = withBanner(solidFrame(W, H, 30), 20, 40, 51, 14);
    const far = detectFrameOccurrences(moved, box, hashFromHex(refRegionHash), refPixels);
    expect(far.length).toBeGreaterThanOrEqual(1);
  });

  it("does not match a plain background plate with the same gates", () => {
    const f = withBanner(solidFrame(W, H, 30), 128, 72, 51, 14);
    const { refRegionHash, refPixels } = refFromFrame(f, box);
    expect(detectFrameOccurrences(page(5), box, hashFromHex(refRegionHash), refPixels)).toEqual([]);
  });
});

describe("normalizedCorrelation", () => {
  it("is 1 for identical buffers and 0 for constant vs varying", () => {
    const a = new Uint8Array([1, 5, 2, 8, 3]);
    const b = new Uint8Array([1, 5, 2, 8, 3]);
    const flat = new Uint8Array(5).fill(4);
    expect(normalizedCorrelation(a, b)).toBeCloseTo(1, 6);
    expect(normalizedCorrelation(a, flat)).toBeCloseTo(0, 6);
  });

  it("tolerates a constant brightness offset", () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    const b = new Uint8Array([14, 24, 34, 44]);
    expect(normalizedCorrelation(a, b)).toBeCloseTo(1, 6);
  });
});

describe("mergeOccurrenceRuns", () => {
  it("merges contiguous samplings on the same spot into one run", () => {
    const rect = { x: 0.2, y: 0.3, w: 0.1, h: 0.1 };
    const runs = mergeOccurrenceRuns([
      { tMs: 1000, rect, sim: 0.9 },
      { tMs: 1166, rect, sim: 0.95 },
      { tMs: 1332, rect, sim: 0.88 },
    ], { runGapMs: 800, cellBits: 7 });
    expect(runs).toHaveLength(1);
    expect(runs[0].t0).toBe(1000);
    expect(runs[0].t1).toBe(1332);
  });

  it("splits runs when the spot moves", () => {
    const a = { x: 0.2, y: 0.3, w: 0.1, h: 0.1 };
    const b = { x: 0.7, y: 0.6, w: 0.1, h: 0.1 };
    const runs = mergeOccurrenceRuns([
      { tMs: 1000, rect: a, sim: 0.9 },
      { tMs: 1166, rect: a, sim: 0.9 },
      { tMs: 1332, rect: b, sim: 0.9 },
      { tMs: 1500, rect: b, sim: 0.9 },
    ], { runGapMs: 800, cellBits: 7 });
    expect(runs).toHaveLength(2);
    expect(runs[1].t0).toBe(1332);
  });

  it("keeps sub-cell refine jitter in the same run (the F6-before leak)", () => {
    // The sub-grid refine moves each detected rect +-2 scan px (256px frame =>
    // 1-2 quantized cells) between consecutive frames. Strict cell equality
    // used to shatter a continuous 3s presence into 100-200ms fragments, so
    // only the first fragment got mosaicked. Within tolerance they merge.
    const j1 = { x: 0.37109375, y: 0.4236111111111111, w: 0.25, h: 0.12 };
    const j2 = { x: 0.37890625, y: 0.4270833333333333, w: 0.25, h: 0.12 };
    const j3 = { x: 0.375, y: 0.4305555555555556, w: 0.25, h: 0.12 };
    const runs = mergeOccurrenceRuns([
      { tMs: 9100, rect: j1, sim: 0.9 },
      { tMs: 9200, rect: j2, sim: 0.93 },
      { tMs: 9300, rect: j3, sim: 0.91 },
      { tMs: 9400, rect: j2, sim: 0.9 },
      // a genuine later relocation still splits
      { tMs: 9500, rect: { x: 0.7, y: 0.6, w: 0.25, h: 0.12 }, sim: 0.9 },
    ], { runGapMs: 800, cellBits: 7 });
    expect(runs).toHaveLength(2);
    expect(runs[0].t0).toBe(9100);
    expect(runs[0].t1).toBe(9400);
  });
});
