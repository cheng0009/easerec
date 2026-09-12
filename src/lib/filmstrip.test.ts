import { describe, expect, it } from "vitest";
import {
  filmStripLayout,
  mainMsToStripPos,
  stripPosToMainMs,
  summarizeMarks,
} from "./filmstrip";
import type { EditEntry } from "../recording/edl";

const e = (over: Partial<EditEntry> & { type: EditEntry["type"] }): EditEntry => ({
  startMs: 0, endMs: 1000, ...over,
} as EditEntry);

describe("filmStripLayout", () => {
  it("empty film: main ~60%, slim end stubs", () => {
    const l = filmStripLayout(0, [], 0, 0, 0);
    expect(l.outputMs).toBe(0);
    const main = l.segs.find((s) => s.kind === "main")!;
    expect(main.width).toBeCloseTo(60, 0);
  });

  it("main dominates; intro+outro split the rest by duration", () => {
    const l = filmStripLayout(600000, [], 3000, 3000, 600000);
    const [intro, main, outro] = l.segs;
    // equal attach durations split the 38% remainder evenly: 19 / 19
    expect(main.width).toBeCloseTo(62, 0);
    expect(intro.width).toBeCloseTo(19, 0);
    expect(outro.width).toBeCloseTo(19, 0);
    expect(Math.round(l.segs.reduce((a, s) => a + s.width, 0))).toBe(100);
    expect(l.outputMs).toBe(606000);
  });

  it("one-sided attach gives the full remainder to that side", () => {
    const l = filmStripLayout(600000, [], 5000, 0, 600000);
    const [intro, , outro] = l.segs;
    // intro raw 38, outro stub 38/6 -> normalized intro ≈ 35.7, outro ≈ 5.9
    expect(intro.width).toBeCloseTo(35.7, 0);
    expect(intro.width).toBeGreaterThan(outro.width * 4);
    expect(l.outputMs).toBe(605000);
  });

  it("output includes edited main length", () => {
    const edits: EditEntry[] = [e({ type: "cut", startMs: 0, endMs: 60000, reason: "rewind" })];
    const l = filmStripLayout(120000, edits, 0, 0, 60000);
    expect(l.outputMs).toBe(60000);
  });
});

describe("strip<->main time mapping", () => {
  const layout = filmStripLayout(100000, [], 4000, 4000, 100000);

  it("positions inside the main segment map proportionally", () => {
    const mainStart = layout.segs[0].width / 100;
    const mainW = layout.segs[1].width / 100;
    // Click at the very start of the main segment:
    expect(stripPosToMainMs(mainStart + 1e-9, layout, 100000)).toBeCloseTo(0, 0);
    // Click at main midpoint:
    expect(stripPosToMainMs(mainStart + mainW / 2, layout, 100000)).toBeCloseTo(50000, -2);
    // Click at main end:
    expect(stripPosToMainMs(mainStart + mainW, layout, 100000)).toBe(100000);
  });

  it("clicks on intro/outro clamp to film ends", () => {
    expect(stripPosToMainMs(0.01, layout, 100000)).toBe(0);
    expect(stripPosToMainMs(0.99, layout, 100000)).toBe(100000);
  });

  it("mainMsToStripPos round-trips and lands inside the main segment", () => {
    const pos = mainMsToStripPos(50000, layout, 100000);
    expect(pos).toBeGreaterThan(layout.segs[0].width / 100);
    expect(pos).toBeLessThan(1 - layout.segs[2].width / 100);
    expect(stripPosToMainMs(pos, layout, 100000)).toBeCloseTo(50000, -1);
  });
});

describe("summarizeMarks", () => {
  it("separates pause cuts from other cuts", () => {
    const edits: EditEntry[] = [
      e({ type: "cut", reason: "rewind" }),
      e({ type: "cut", reason: "privacy" }),
      e({ type: "cut", reason: "pause" }),
      e({ type: "mask" }),
      e({ type: "speedup" }),
    ];
    const s = summarizeMarks(edits);
    expect(s.cuts).toBe(2);
    expect(s.pauses).toBe(1);
    expect(s.masks).toBe(1);
    expect(s.speedups).toBe(1);
    expect(s.active).toBe(false);
  });

  it("active flags come from open marks", () => {
    expect(summarizeMarks([], { activePrivacy: true }).active).toBe(true);
    expect(summarizeMarks([], { activeFF: true }).active).toBe(true);
    expect(summarizeMarks([], { activePause: true }).active).toBe(true);
    expect(summarizeMarks([], { activePrivacyCut: true }).active).toBe(true);
  });
});
