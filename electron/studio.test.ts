import { describe, expect, it } from "vitest";
import { studioRect } from "./studio";

describe("studioRect (16:9 arrangement)", () => {
  it("fits a 16:9 screen exactly", () => {
    expect(studioRect(1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  it("letterboxes a taller screen", () => {
    const r = studioRect(1080, 1920); // portrait
    expect(r.w).toBeLessThanOrEqual(1080);
    expect(Math.abs(r.h - r.w * 9 / 16)).toBeLessThan(1);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThan(0);
  });

  it("pillarboxes an ultra-wide screen", () => {
    const r = studioRect(3440, 1440);
    expect(r.h).toBeLessThanOrEqual(1440);
    expect(Math.abs(r.w - r.h * 16 / 9)).toBeLessThan(2);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.x).toBeGreaterThan(0);
  });
});
