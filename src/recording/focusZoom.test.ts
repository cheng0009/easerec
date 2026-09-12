import { describe, expect, it } from "vitest";
import {
  buildZoompanGraph,
  cameraAt,
  cameraToRects,
  downsampleCamera,
  lerpExpression,
  parseMouseTrack,
  replayCamera,
  viewportRect,
  type CameraFrame,
  type MouseTrackSample,
} from "./focusZoom";

/** Synthetic trajectory: idle at center for 2s, sweep to (0.8, 0.3) over 3s,
 *  stay 2s (dwell → zoom in), back to center over 2s. 30ms cadence. */
function demoTrack(): MouseTrackSample[] {
  const out: MouseTrackSample[] = [];
  const push = (tMs: number, x: number, y: number) => out.push({ tMs, x, y });
  let t = 0;
  for (; t <= 2000; t += 30) push(t, 0.5, 0.5);
  for (; t <= 5000; t += 30) {
    const a = (t - 2000) / 3000;
    push(t, 0.5 + 0.3 * a, 0.5 - 0.2 * a);
  }
  for (; t <= 7000; t += 30) push(t, 0.8, 0.3);
  for (; t <= 9000; t += 30) {
    const a = (t - 7000) / 2000;
    push(t, 0.8 - 0.3 * a, 0.3 + 0.2 * a);
  }
  return out;
}

describe("replayCamera", () => {
  it("stays centered at fit while the cursor idles in the center zone", () => {
    const cam = replayCamera(demoTrack().filter((s) => s.tMs <= 2000), {
      sourceWidth: 1920, sourceHeight: 1080, zoomLevel: 1.5,
    });
    expect(cam.length).toBeGreaterThan(10);
    for (const f of cam) {
      expect(f.cx).toBeCloseTo(0.5, 2);
      expect(f.cy).toBeCloseTo(0.5, 2);
      expect(f.scale).toBeCloseTo(1.0, 2);
    }
  });

  it("zooms in while dwelling away from center and eases back", () => {
    const track = demoTrack();
    const cam = replayCamera(track, { sourceWidth: 1920, sourceHeight: 1080, zoomLevel: 1.5 });
    const at = (tMs: number): CameraFrame => cam.reduce((best, f) => (Math.abs(f.tMs - tMs) < Math.abs(best.tMs - tMs) ? f : best), cam[0]);
    // During the dwell (5-7s) the camera should be zoomed toward (0.8, 0.3).
    const dwell = at(6500);
    expect(dwell.scale).toBeGreaterThan(1.2);
    expect(dwell.cx).toBeGreaterThan(0.6);
    expect(dwell.cy).toBeLessThan(0.45);
    // After returning to center, back at fit.
    const end = at(8900);
    expect(end.scale).toBeLessThan(1.15);
  });

  it("clamps everything into valid ranges", () => {
    const cam = replayCamera(demoTrack(), { sourceWidth: 1920, sourceHeight: 1080, zoomLevel: 1.5 });
    for (const f of cam) {
      expect(f.cx).toBeGreaterThanOrEqual(0);
      expect(f.cx).toBeLessThanOrEqual(1);
      expect(f.cy).toBeGreaterThanOrEqual(0);
      expect(f.cy).toBeLessThanOrEqual(1);
      expect(f.scale).toBeGreaterThanOrEqual(1);
    }
  });

  it("empty track yields empty camera", () => {
    expect(replayCamera([], { sourceWidth: 1920, sourceHeight: 1080, zoomLevel: 1.5 })).toEqual([]);
  });
});

describe("downsampleCamera", () => {
  it("reduces a smooth curve to few keyframes but keeps coverage", () => {
    const cam = replayCamera(demoTrack(), { sourceWidth: 1920, sourceHeight: 1080, zoomLevel: 1.5 });
    const keys = downsampleCamera(cam);
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.length).toBeLessThan(cam.length / 5);
    expect(keys[0].tMs).toBe(cam[0].tMs);
    expect(Math.max(...keys.map((k) => k.tMs))).toBeGreaterThanOrEqual(cam[cam.length - 1].tMs - 1);
    // Max gap respected.
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i].tMs - keys[i - 1].tMs).toBeLessThanOrEqual(1600);
    }
  });

  it("static camera collapses to (almost) one keyframe", () => {
    const cam = replayCamera(demoTrack().filter((s) => s.tMs <= 2000), {
      sourceWidth: 1920, sourceHeight: 1080, zoomLevel: 1.5,
    });
    const keys = downsampleCamera(cam);
    expect(keys.length).toBeLessThan(6);
  });
});

describe("viewportRect / cameraToRects", () => {
  it("fit camera covers the whole source", () => {
    const r = viewportRect({ tMs: 0, cx: 0.5, cy: 0.5, scale: 1 }, 1920, 1080);
    expect(r.x).toBeCloseTo(0, 5);
    expect(r.y).toBeCloseTo(0, 5);
    expect(r.w).toBeCloseTo(1920, 5);
    expect(r.h).toBeCloseTo(1080, 5);
  });

  it("zoomed viewport is centered on the camera and clamped", () => {
    const r = viewportRect({ tMs: 0, cx: 0.0, cy: 0.0, scale: 2 }, 1920, 1080);
    expect(r.w).toBeCloseTo(960, 3);
    expect(r.h).toBeCloseTo(540, 3);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    const r2 = viewportRect({ tMs: 0, cx: 1, cy: 1, scale: 2 }, 1920, 1080);
    expect(r2.x).toBeCloseTo(960, 3);
    expect(r2.y).toBeCloseTo(540, 3);
  });

  it("normalized rects stay within 0..1", () => {
    const rects = cameraToRects([
      { tMs: 0, cx: 0.5, cy: 0.5, scale: 1 },
      { tMs: 1000, cx: 0.2, cy: 0.8, scale: 1.6 },
    ], 1920, 1080);
    for (const r of rects) {
      for (const v of [r.x, r.y, r.w, r.h]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1.0001);
      }
    }
  });
});

describe("lerpExpression / buildZoompanGraph", () => {
  it("constant sequence collapses to a constant", () => {
    const expr = lerpExpression(
      [{ tMs: 0, cx: 0.5, cy: 0.5, scale: 1 }, { tMs: 5000, cx: 0.5, cy: 0.5, scale: 1 }],
      (k) => k.scale,
      "T",
    );
    expect(expr).toBe("1");
  });

  it("two-point ramp produces a flat clip/gte term (nesting-safe)", () => {
    const expr = lerpExpression(
      [{ tMs: 0, cx: 0, cy: 0, scale: 1 }, { tMs: 2000, cx: 0, cy: 0, scale: 1.5 }],
      (k) => k.scale,
      "T",
    );
    expect(expr).toBe("1+(0.5)*(clip((T-0)/2,0,1)-gte(T,2))");
  });

  it("expressions stay shallow for hundreds of segments (regression: EINVAL)", () => {
    // 500 moving segments used to nest 500 if-layers deep (parser death).
    const keys = Array.from({ length: 501 }, (_, i) => ({
      tMs: i * 200,
      cx: 0.5 + 0.1 * Math.sin(i / 7),
      cy: 0.5,
      scale: 1 + 0.3 * Math.abs(Math.sin(i / 11)),
    }));
    const expr = lerpExpression(keys, (k) => k.scale, "(on/30)");
    expect(expr.length).toBeGreaterThan(1000);
    expect(expr.split("if(").length - 1).toBe(0); // ZERO nested ifs
  });

  it("graph wires fps, size and the three expressions", () => {
    const graph = buildZoompanGraph(
      [{ tMs: 0, cx: 0.5, cy: 0.5, scale: 1 }],
      { fps: 30, sourceWidth: 1920, sourceHeight: 1080, outputWidth: 1920, outputHeight: 1080 },
    );
    expect(graph).toContain("[0:v]fps=30");
    expect(graph).toContain("zoompan=z='1':x='0':y='0'");
    expect(graph).toContain("s=1920x1080:fps=30");
    expect(graph.endsWith("[v]")).toBe(true);
  });

  it("T is expressed via the output frame counter", () => {
    const graph = buildZoompanGraph(
      [{ tMs: 0, cx: 0.5, cy: 0.5, scale: 1 }, { tMs: 1000, cx: 0.6, cy: 0.5, scale: 1.4 }],
      { fps: 25, sourceWidth: 1920, sourceHeight: 1080, outputWidth: 1280, outputHeight: 720 },
    );
    expect(graph).toContain("(on/25)");
    expect(graph).toContain("s=1280x720");
  });
});

describe("parseMouseTrack", () => {
  it("parses JSONL and sorts/clamps", () => {
    const raw = [
      '{"tMs":300,"x":0.4,"y":0.6}',
      '{"tMs":0,"x":0.5,"y":0.5}',
      "garbage",
      "",
      '{"tMs":100,"x":-1,"y":2}',
    ].join("\n");
    const track = parseMouseTrack(raw);
    expect(track.map((s) => s.tMs)).toEqual([0, 100, 300]);
    expect(track[1].x).toBe(0);
    expect(track[1].y).toBe(1);
  });

  it("empty input yields empty track", () => {
    expect(parseMouseTrack("")).toEqual([]);
  });
});

describe("cameraAt", () => {
  const frames: CameraFrame[] = [
    { tMs: 0, cx: 0.5, cy: 0.5, scale: 1 },
    { tMs: 1000, cx: 0.6, cy: 0.4, scale: 1.2 },
    { tMs: 2000, cx: 0.7, cy: 0.3, scale: 1.4 },
  ];

  it("clamps before/after the range", () => {
    expect(cameraAt(frames, -5)).toEqual({ cx: 0.5, cy: 0.5, scale: 1 });
    expect(cameraAt(frames, 99999)).toEqual({ cx: 0.7, cy: 0.3, scale: 1.4 });
    expect(cameraAt([], 100)).toEqual({ cx: 0.5, cy: 0.5, scale: 1 });
  });

  it("interpolates linearly between frames", () => {
    const mid = cameraAt(frames, 1500);
    expect(mid.cx).toBeCloseTo(0.65, 5);
    expect(mid.cy).toBeCloseTo(0.35, 5);
    expect(mid.scale).toBeCloseTo(1.3, 5);
  });
});
