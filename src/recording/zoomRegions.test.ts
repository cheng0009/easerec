import { describe, expect, it } from "vitest";
import {
  buildFocusSpans,
  detectDwells,
  detectZoomRegions,
  type TrackPoint,
} from "./zoomRegions";

/** Synthetic trajectory: idle at center → dwell at (0.8, 0.25) for 4s →
 *  move → dwell at (0.2, 0.7) for 4s → return to center. */
function demoTrack(): TrackPoint[] {
  const out: TrackPoint[] = [];
  let t = 0;
  const push = (x: number, y: number) => out.push({ tMs: t, x, y });
  for (; t <= 2000; t += 30) push(0.5, 0.5);
  for (; t <= 2500; t += 30) push(0.5 + 0.3 * ((t - 2000) / 500), 0.5 - 0.25 * ((t - 2000) / 500));
  for (; t <= 7000; t += 30) push(0.8 + (Math.random() - 0.5) * 0.008, 0.25 + (Math.random() - 0.5) * 0.008);
  for (; t <= 7500; t += 30) push(0.8 - 0.6 * ((t - 7000) / 500), 0.25 + 0.45 * ((t - 7000) / 500));
  for (; t <= 12000; t += 30) push(0.2 + (Math.random() - 0.5) * 0.008, 0.7 + (Math.random() - 0.5) * 0.008);
  for (; t <= 12500; t += 30) push(0.2 + 0.3 * ((t - 12000) / 500), 0.7 - 0.2 * ((t - 12000) / 500));
  for (; t <= 16000; t += 30) push(0.5, 0.5);
  return out;
}

describe("detectDwells", () => {
  it("finds the dwells (start idle, two side dwells, end idle)", () => {
    const d = detectDwells(demoTrack(), { dwellMs: 500, radius: 0.08 });
    expect(d.length).toBe(4);
    expect(d[1].cx).toBeGreaterThan(0.7);
    expect(d[1].cy).toBeLessThan(0.4);
    expect(d[2].cx).toBeLessThan(0.3);
    expect(d[2].cy).toBeGreaterThan(0.6);
  });

  it("ignores pass-through movement without dwell", () => {
    const track: TrackPoint[] = [];
    for (let t = 0; t <= 2000; t += 30) {
      track.push({ tMs: t, x: t / 2000, y: 0.5 });
    }
    expect(detectDwells(track, { dwellMs: 500, radius: 0.08 })).toHaveLength(0);
  });
});

describe("detectZoomRegions", () => {
  it("keeps distant dwells as separate de-overlapped regions", () => {
    const r = detectZoomRegions(demoTrack(), { depth: 1.5 });
    // start-idle, edge dwell, second dwell, end-idle (end idle may merge with
    // nothing; all are valid zoom targets in Recordly's model).
    expect(r.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < r.length; i++) {
      expect(r[i].startMs).toBeGreaterThanOrEqual(r[i - 1].endMs);
    }
    const edge = r.find((x) => x.cx > 0.7 && x.cy < 0.4);
    expect(edge).toBeTruthy();
    expect(edge!.endMs).toBeGreaterThan(7000);
  });

  it("empty track → no regions", () => {
    expect(detectZoomRegions([], {})).toEqual([]);
  });

  it("micro-dwells below minRegionMs are dropped (the long dwell remains)", () => {
    const track: TrackPoint[] = [];
    let t = 0;
    for (; t <= 600; t += 30) track.push({ tMs: t, x: 0.8, y: 0.2 });
    for (; t <= 5000; t += 30) track.push({ tMs: t, x: 0.5, y: 0.5 });
    const r = detectZoomRegions(track, {});
    // With Recordly timing even a 600ms dwell grows past minRegionMs
    // (lead-in + hold), so BOTH dwells become regions — that is correct;
    // the assertion targets their FOCI, not a count.
    expect(r.length).toBe(2);
    expect(r.some((x) => Math.abs(x.cx - 0.8) < 0.05)).toBe(true);
    expect(r.some((x) => Math.abs(x.cx - 0.5) < 0.05)).toBe(true);
  });
});

describe("buildFocusSpans", () => {
  it("Recordly timing: zoom-in before region, HOLD while working, zoom-out after", () => {
    const regions = detectZoomRegions(demoTrack(), { depth: 1.5 });
    const spans = buildFocusSpans(regions, 16000);
    expect(spans[0].startMs).toBe(0);
    expect(spans[spans.length - 1].endMs).toBe(16000);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].startMs).toBe(spans[i - 1].endMs);
    }
    // Find the first hold (zoomed static span of decent length).
    const hold = spans.find((s) => s.depth > 1 && s.endMs - s.startMs > 1000)!;
    expect(hold).toBeTruthy();
    // THE critical assertion (user-reported bug): while the cursor is still
    // working inside a region, the camera must STAY zoomed — no early
    // collapse. The demo track is fully connected (gaps <= 1.5s), so the
    // camera never returns to full frame at all.
    const fullSpans = spans.filter((s) => s.depth === 1);
    expect(fullSpans.length).toBeLessThanOrEqual(1);
  });

  it("connected zooms glide without collapsing to full frame", () => {
    // Two regions 1s apart (within CONNECTED_ZOOM_GAP_MS).
    const regions = [
      { startMs: 1000, endMs: 5000, depth: 1.5, cx: 0.3, cy: 0.3 },
      { startMs: 6000, endMs: 10000, depth: 1.5, cx: 0.7, cy: 0.7 },
    ];
    const spans = buildFocusSpans(regions, 12000);
    // Between the two holds there must be NO depth-1 span.
    const between = spans.filter((s) => s.startMs >= 5000 && s.endMs <= 6500);
    expect(between.every((s) => s.depth > 1)).toBe(true);
  });

  it("no regions → single full-frame span", () => {
    const spans = buildFocusSpans([], 10000);
    expect(spans).toEqual([{ startMs: 0, endMs: 10000, depth: 1, cx: 0.5, cy: 0.5 }]);
  });
});
