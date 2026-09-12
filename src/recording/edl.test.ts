import { describe, expect, it } from "vitest";
import {
  appendEdit,
  buildTimeline,
  edlReport,
  emptyEdl,
  formatClock,
  normalizeEdits,
  outputToSourceMs,
  parseEdl,
  privacyCutForMask,
  replaceEdit,
  sourceToOutputMs,
  type CutEdit,
  type MaskEdit,
  type SpeedupEdit,
} from "./edl";

const cut = (startMs: number, endMs: number, reason: CutEdit["reason"] = "rewind"): CutEdit =>
  ({ type: "cut", startMs, endMs, reason });
const speedup = (startMs: number, endMs: number, targetSecs: [number, number] = [3, 5]): SpeedupEdit =>
  ({ type: "speedup", startMs, endMs, targetSecs, audio: "whoosh" });
const mask = (startMs: number, endMs: number, region = { x: 0.6, y: 0.1, w: 0.3, h: 0.08 }): MaskEdit =>
  ({ type: "mask", startMs, endMs, region, style: "black", muteAudio: false, startSource: "grace" });

describe("appendEdit / normalizeEdits", () => {
  it("appends a valid edit", () => {
    const edl = appendEdit(emptyEdl(), cut(1000, 4000));
    expect(edl.edits).toHaveLength(1);
    expect(edl.edits[0]).toMatchObject({ type: "cut", startMs: 1000, endMs: 4000, reason: "rewind" });
  });

  it("rejects malformed edits but clamps a pre-recording start to 0", () => {
    const edl = appendEdit(emptyEdl(), { type: "cut", startMs: -5, endMs: 10 } as unknown as CutEdit);
    expect(edl.edits).toHaveLength(1);
    expect(edl.edits[0]).toMatchObject({ startMs: 0, endMs: 10 });
    expect(appendEdit(emptyEdl(), { type: "wat" } as unknown as CutEdit).edits).toHaveLength(0);
    // Non-numeric / negative-end / missing-end all reject.
    expect(appendEdit(emptyEdl(), { type: "cut", startMs: "x", endMs: 5 } as unknown as CutEdit).edits).toHaveLength(0);
    expect(appendEdit(emptyEdl(), { type: "cut", startMs: 5, endMs: -5 } as unknown as CutEdit).edits).toHaveLength(0);
    expect(appendEdit(emptyEdl(), { type: "cut", startMs: 5 } as unknown as CutEdit).edits).toHaveLength(0);
  });

  it("merges two touching rewind cuts into one", () => {
    const edl = appendEdit(appendEdit(emptyEdl(), cut(5000, 8000)), cut(8000, 11000));
    expect(edl.edits).toHaveLength(1);
    expect(edl.edits[0]).toMatchObject({ startMs: 5000, endMs: 11000 });
  });

  it("merges overlapping cuts even out of order", () => {
    const edl = appendEdit(appendEdit(emptyEdl(), cut(10000, 12000)), cut(5000, 10500));
    expect(edl.edits).toHaveLength(1);
    expect(edl.edits[0]).toMatchObject({ startMs: 5000, endMs: 12000 });
  });

  it("drops a speedup that lies fully inside a cut", () => {
    const edl = appendEdit(appendEdit(emptyEdl(), cut(0, 60000)), speedup(10000, 20000));
    expect(edl.edits).toHaveLength(1);
    expect(edl.edits[0].type).toBe("cut");
  });

  it("keeps a speedup that only partially overlaps a cut and trims ordering", () => {
    const edits = normalizeEdits([cut(20000, 30000), speedup(25000, 40000)]);
    // Overlapping speedup is NOT inside the cut -> kept (the exporter clamps).
    expect(edits.some((e) => e.type === "speedup")).toBe(true);
  });

  it("merges identical adjacent masks but not different regions", () => {
    const same = appendEdit(appendEdit(emptyEdl(), mask(1000, 2000)), mask(2000, 3000));
    expect(same.edits).toHaveLength(1);
    const diff = appendEdit(
      appendEdit(emptyEdl(), mask(1000, 2000)),
      mask(2000, 3000, { x: 0.1, y: 0.1, w: 0.3, h: 0.08 }),
    );
    expect(diff.edits).toHaveLength(2);
  });

  it("clamps mask regions into 0..1", () => {
    const edl = appendEdit(emptyEdl(), { ...mask(0, 1000), region: { x: 1.5, y: -0.2, w: 0, h: 2 } });
    const m = edl.edits[0] as MaskEdit;
    expect(m.region.x).toBe(1);
    expect(m.region.y).toBe(0);
    expect(m.region.w).toBeGreaterThan(0);
    expect(m.region.h).toBe(1);
  });
});

describe("parseEdl", () => {
  it("round-trips a serialized EDL", () => {
    let edl = appendEdit(appendEdit(emptyEdl("2026-01-01"), cut(0, 3000)), mask(5000, 8000));
    edl = { ...edl, durationMs: 60000, finalized: true };
    const back = parseEdl(JSON.parse(JSON.stringify(edl)));
    expect(back).not.toBeNull();
    expect(back!.edits).toHaveLength(2);
    expect(back!.finalized).toBe(true);
    expect(back!.durationMs).toBe(60000);
  });

  it("tolerates garbage and wrong versions", () => {
    expect(parseEdl(null)).toBeNull();
    expect(parseEdl("x")).toBeNull();
    expect(parseEdl({ version: 2 })).toBeNull();
    expect(parseEdl({ version: 1, edits: [{ type: "cut", startMs: "x", endMs: 5 }, 42, null] })!.edits).toHaveLength(0);  });
});

describe("buildTimeline", () => {
  it("passes through when there are no edits", () => {
    const segs = buildTimeline(emptyEdl(), 10000);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ srcStartMs: 0, srcEndMs: 10000, outStartMs: 0, outEndMs: 10000, speed: 1 });
  });

  it("removes cut ranges and keeps output time continuous", () => {
    let edl = emptyEdl();
    edl = appendEdit(edl, cut(2000, 5000));
    const segs = buildTimeline(edl, 10000);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ srcStartMs: 0, srcEndMs: 2000, outStartMs: 0, outEndMs: 2000 });
    expect(segs[1]).toMatchObject({ srcStartMs: 5000, srcEndMs: 10000, outStartMs: 2000, outEndMs: 7000 });
  });

  it("compresses a speedup range into the clamped target window", () => {
    const edl = appendEdit(emptyEdl(), speedup(1000, 61000)); // 60s source
    const segs = buildTimeline(edl, 70000);
    expect(segs).toHaveLength(3);
    const sp = segs[1];
    expect(sp.speed).toBeCloseTo(60 / 5, 5); // clamped to 5s
    expect(sp.outEndMs - sp.outStartMs).toBeCloseTo(5000, 4);
    expect(segs[2].outStartMs).toBeCloseTo(1000 + 5000, 4);
  });

  it("expands a short speedup to the minimum target", () => {
    const edl = appendEdit(emptyEdl(), { ...speedup(1000, 2500), targetSecs: [3, 5] }); // 1.5s source
    const segs = buildTimeline(edl, 5000);
    const sp = segs[1];
    expect(sp.outEndMs - sp.outStartMs).toBeCloseTo(3000, 4);
    expect(sp.speed).toBeCloseTo(0.5, 5);
  });

  it("handles rewind + fast-forward + mask together", () => {
    let edl = emptyEdl();
    edl = appendEdit(edl, cut(30000, 33000)); // rewind privacy mistake
    edl = appendEdit(edl, mask(40000, 50000)); // masked corner, 1:1 time
    edl = appendEdit(edl, speedup(60000, 120000)); // 60s -> 5s
    const segs = buildTimeline(edl, 130000);
    // keep 0-30 | cut | keep 33-40 | mask 40-50 | keep 50-60 | speed 60-120 | keep 120-130
    expect(segs).toHaveLength(6);
    expect(segs[1]).toMatchObject({ srcStartMs: 33000, srcEndMs: 40000, speed: 1 });
    expect(segs[2]).toMatchObject({ srcStartMs: 40000, srcEndMs: 50000, speed: 1 });
    const sp = segs.find((s) => s.via !== "keep")!;
    expect(sp.srcStartMs).toBe(60000);
    expect(sp.outEndMs - sp.outStartMs).toBeCloseTo(5000, 4);
    const last = segs[5];
    expect(last.srcStartMs).toBe(120000);
    // 37s keep (40s minus the 3s cut) + 10s mask + 10s keep + 5s speedup + 10s keep
    expect(last.outEndMs).toBeCloseTo(37000 + 10000 + 10000 + 5000 + 10000, 0);
  });

  it("clamps edits beyond the known duration", () => {
    const edl = appendEdit(emptyEdl(), cut(8000, 20000));
    const segs = buildTimeline(edl, 10000);
    expect(segs).toHaveLength(1);
    expect(segs[0].outEndMs).toBe(8000);
  });
});

describe("time mapping", () => {
  it("maps source->output across a cut", () => {
    let edl = emptyEdl();
    edl = appendEdit(edl, cut(2000, 5000));
    const segs = buildTimeline(edl, 10000);
    expect(sourceToOutputMs(segs, 1000)).toBe(1000);
    expect(sourceToOutputMs(segs, 2000)).toBe(2000);
    expect(sourceToOutputMs(segs, 5000)).toBe(2000);
    expect(sourceToOutputMs(segs, 10000)).toBe(7000);
  });

  it("maps output->source (inverse) including speedups", () => {
    let edl = emptyEdl();
    edl = appendEdit(edl, cut(2000, 5000));
    edl = appendEdit(edl, speedup(60000, 120000));
    const segs = buildTimeline(edl, 130000);
    expect(outputToSourceMs(segs, 0)).toBe(0);
    // The 3s cut shifts later output: output 22s == source 25s.
    expect(outputToSourceMs(segs, 22000)).toBe(25000);
    expect(outputToSourceMs(segs, 25000)).toBe(28000);
    // output 30s == source 33s (after the 3s cut)
    expect(outputToSourceMs(segs, 30000)).toBe(33000);
    // inside the speedup: out 60s..65s == src 60s..120s
    const sp = segs.find((s) => s.via !== "keep")!;
    expect(outputToSourceMs(segs, sp.outStartMs)).toBe(60000);
    expect(outputToSourceMs(segs, sp.outEndMs)).toBe(120000);
    // round trips
    for (const out of [0, 5000, 29999, 62500, 70000 - 3000 + 5000]) {
      expect(Math.round(sourceToOutputMs(segs, outputToSourceMs(segs, out)))).toBeCloseTo(
        Math.min(out, segs[segs.length - 1].outEndMs), 0,
      );
    }
  });
});

describe("privacy trim (privacyCutForMask)", () => {
  it("cuts [content first appearance -> box drawn] with reason privacy", () => {
    const m: MaskEdit = { ...mask(5000, 60000), drawnAtMs: 12000 };
    expect(privacyCutForMask(m)).toEqual({ type: "cut", startMs: 5000, endMs: 12000, reason: "privacy" });
  });

  it("returns null without a drawn-at time (old EDLs keep legacy behavior)", () => {
    expect(privacyCutForMask(mask(5000, 60000))).toBeNull();
  });

  it("returns null for a trivially short leak window", () => {
    const m: MaskEdit = { ...mask(12000, 60000), drawnAtMs: 12050 };
    expect(privacyCutForMask(m, 200)).toBeNull();
  });

  it("clamps negative starts (content appeared at frame zero)", () => {
    const m: MaskEdit = { ...mask(0, 60000), drawnAtMs: 3000 };
    expect(privacyCutForMask(m)).toEqual({ type: "cut", startMs: 0, endMs: 3000, reason: "privacy" });
  });

  it("keeps pre-appearance demo footage but drops the leak window in the timeline", () => {
    // content first visible at 5s (backtrace), box drawn at 12s (drawnAtMs)
    const m: MaskEdit = { ...mask(5000, 60000), drawnAtMs: 12000 };
    let edl = appendEdit(emptyEdl(), m);
    const pc = privacyCutForMask(m)!;
    edl = appendEdit(edl, pc);
    const segs = buildTimeline(edl, 60000);
    // keep [0,5s) untouched, [5s,12s) removed, [12s,60s] kept (mosaicked)
    expect(segs.map((s) => [s.srcStartMs, s.srcEndMs])).toEqual([
      [0, 5000],
      [12000, 60000],
    ]);
    expect(edlReport(edl, 60000).cuts).toEqual({ count: 1, totalMs: 7000 });
  });
});

describe("edlReport / helpers", () => {
  it("summarizes the timeline", () => {
    let edl = emptyEdl();
    edl = appendEdit(edl, cut(30000, 33000));
    edl = appendEdit(edl, mask(40000, 50000));
    edl = appendEdit(edl, speedup(60000, 120000));
    const rep = edlReport(edl, 130000);
    expect(rep.cuts).toEqual({ count: 1, totalMs: 3000 });
    expect(rep.masks).toEqual({ count: 1, totalMs: 10000 });
    expect(rep.speedups.count).toBe(1);
    expect(rep.speedups.sourceMs).toBe(60000);
    expect(rep.speedups.outputMs).toBeCloseTo(5000, 0);
    expect(rep.outputDurationMs).toBe(130000 - 3000 - 60000 + 5000);
  });

  it("formats clocks", () => {
    expect(formatClock(0)).toBe("00:00:00");
    expect(formatClock(3723456)).toBe("01:02:03");
  });

  it("replaceEdit updates an entry and renormalizes", () => {
    let edl = appendEdit(emptyEdl(), cut(1000, 2000));
    edl = replaceEdit(edl, 0, cut(500, 900));
    expect(edl.edits[0]).toMatchObject({ startMs: 500, endMs: 900 });
    expect(replaceEdit(edl, 99, cut(0, 1)).edits).toHaveLength(1);
  });
});
