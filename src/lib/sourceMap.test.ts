import { describe, expect, it } from "vitest";
import {
  clampScreenRectToSource,
  hwndFromSourceId,
  isWindowSource,
  mapScreenRectToSource,
} from "./sourceMap";
import { webcamLayout } from "./webcamLayout";

describe("mapScreenRectToSource", () => {
  const primary = { x: 0, y: 0, w: 1920, h: 1080 };

  it("identity when capturing the primary screen", () => {
    const box = { x: 0.6, y: 0.1, w: 0.3, h: 0.08 };
    const m = mapScreenRectToSource(box, primary, 1920, 1080)!;
    expect(m.x).toBeCloseTo(0.6, 6);
    expect(m.y).toBeCloseTo(0.1, 6);
    expect(m.w).toBeCloseTo(0.3, 6);
    expect(m.h).toBeCloseTo(0.08, 6);
  });

  it("maps into a window that occupies the top-left quadrant", () => {
    // Window rect: top-left quarter of the primary screen.
    const win = { x: 0, y: 0, w: 960, h: 540 };
    // Box over the window's bottom-right corner region.
    const box = { x: 0.25, y: 0.25, w: 0.2, h: 0.2 }; // DIP 480..864, 270..486
    const mapped = mapScreenRectToSource(box, win, 1920, 1080)!;
    expect(mapped.x).toBeCloseTo(0.5, 2);  // (480-0)/960
    expect(mapped.y).toBeCloseTo(0.5, 2);
    expect(mapped.w).toBeCloseTo((864 - 480) / 960, 2);
    expect(mapped.h).toBeCloseTo((486 - 270) / 540, 2);
  });

  it("rejects a box on another monitor", () => {
    const box = { x: 1.2, y: 0.1, w: 0.3, h: 0.1 }; // beyond primary
    expect(mapScreenRectToSource(box, primary, 1920, 1080)).toBeNull();
  });

  it("rejects a box mostly outside the window", () => {
    const win = { x: 0, y: 0, w: 480, h: 270 }; // small window top-left
    const box = { x: 0.2, y: 0.2, w: 0.5, h: 0.4 }; // mostly outside
    expect(mapScreenRectToSource(box, win, 1920, 1080)).toBeNull();
  });

  it("rejects a tiny intersection", () => {
    const win = { x: 0, y: 0, w: 960, h: 540 };
    const box = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }; // only corner touches
    const res = mapScreenRectToSource(box, win, 1920, 1080);
    // The intersection is 0x0 -> null.
    expect(res).toBeNull();
  });
});

describe("clampScreenRectToSource", () => {
  const primary = { x: 0, y: 0, w: 1920, h: 1080 };

  it("identity when capturing the primary screen", () => {
    const m = clampScreenRectToSource({ x: 0.2, y: 0.1, w: 0.3, h: 0.05 }, primary, 1920, 1080)!;
    expect(m.x).toBeCloseTo(0.2, 6);
    expect(m.y).toBeCloseTo(0.1, 6);
    expect(m.w).toBeCloseTo(0.3, 6);
    expect(m.h).toBeCloseTo(0.05, 6);
  });

  it("clamps a box partially outside a window source", () => {
    // Window: top-left quarter. Box hangs over the window's right/bottom edge.
    const win = { x: 0, y: 0, w: 480, h: 270 };
    const box = { x: 0.2, y: 0.2, w: 0.5, h: 0.4 };
    const m = clampScreenRectToSource(box, win, 1920, 1080)!;
    // Clamped to the window in source-normalized coords: full size except the
    // overhang is trimmed => w = (480-384)/480 = 0.2, h = 0.2 (rows 432..590 -> 270 => h=(270-216)/270...).
    expect(m.x).toBeCloseTo(0.8, 6);
    expect(m.y).toBeCloseTo(0.8, 6);
    expect(m.w).toBeCloseTo(0.2, 6);
    expect(m.h).toBeCloseTo(0.2, 6);
  });

  it("accepts the mapScreenRectToSource case it would reject (mostly outside)", () => {
    const win = { x: 0, y: 0, w: 960, h: 540 }; // top-left half
    // Box hangs most of its area over the source's right edge: 96x108 of
    // 384x216 stays inside (12.5% overlap) — mapScreenRectToSource rejects it,
    // the clamp variant trims it into the source instead.
    const box = { x: 0.45, y: 0.05, w: 0.2, h: 0.1 };
    expect(mapScreenRectToSource(box, win, 1920, 1080)).toBeNull();
    const m = clampScreenRectToSource(box, win, 1920, 1080)!;
    expect(m.x).toBeCloseTo(0.9, 6); // flush against the source right edge
    expect(m.w).toBeCloseTo(0.1, 6);
  });

  it("rejects when there is no overlap at all", () => {
    const box = { x: 1.2, y: 0.1, w: 0.3, h: 0.1 }; // beyond primary
    expect(clampScreenRectToSource(box, primary, 1920, 1080)).toBeNull();
  });
});

describe("source id parsing", () => {
  it("detects window sources and extracts hwnd", () => {
    expect(isWindowSource("window:197646:0")).toBe(true);
    expect(isWindowSource("screen:0:0")).toBe(false);
    expect(hwndFromSourceId("window:197646:0")).toBe(197646);
    expect(hwndFromSourceId("screen:0:0")).toBeNull();
  });
});

describe("webcamLayout", () => {
  const base = {
    position: "bottom_right" as const,
    customX: 0.5, customY: 0.5,
    sizeRatio: 0.2,
    shape: "rounded_rect" as const,
    borderColor: "#ffffff",
    borderWidth: 2,
    cornerRadius: 0.15,
  };

  it("bottom_right pins with padding", () => {
    const l = webcamLayout(1920, 1080, base, 4 / 3);
    expect(l.w).toBeCloseTo(384, 0);
    expect(l.h).toBeCloseTo(288, 0);
    expect(l.x).toBeCloseTo(1920 - 384 - 24, 0);
    expect(l.y).toBeCloseTo(1080 - 288 - 24, 0);
    expect(l.circle).toBe(false);
  });

  it("circle uses half-min as radius", () => {
    const l = webcamLayout(1920, 1080, { ...base, shape: "circle" }, 4 / 3);
    expect(l.circle).toBe(true);
    expect(l.radius).toBeCloseTo(144, 0);
  });

  it("custom position clamps inside the canvas", () => {
    const l = webcamLayout(1920, 1080, { ...base, position: "custom", customX: 0, customY: 0 }, 4 / 3);
    expect(l.x).toBeGreaterThanOrEqual(24);
    expect(l.y).toBeGreaterThanOrEqual(24);
    const r = webcamLayout(1920, 1080, { ...base, position: "custom", customX: 1, customY: 1 }, 4 / 3);
    expect(r.x + r.w).toBeLessThanOrEqual(1920 - 24 + 1);
    expect(r.y + r.h).toBeLessThanOrEqual(1080 - 24 + 1);
  });

  it("size ratio clamps to sane bounds", () => {
    const l = webcamLayout(1920, 1080, { ...base, sizeRatio: 0.9 }, 4 / 3);
    expect(l.w).toBeLessThanOrEqual(1920 * 0.5);
  });
});
