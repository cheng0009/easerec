import { describe, expect, it } from "vitest";
import { planPlacement, placementsToSubtitleSegments, MAX_ATEMPO } from "./placement";

describe("voice-swap placement", () => {
  it("keeps a clip that fits its slot untouched (atempo 1)", () => {
    const p = planPlacement([
      { startMs: 1000, endMs: 3000, text: "你好", synthMs: 1500, file: "a.mp3" },
      { startMs: 5000, endMs: 7000, text: "世界", synthMs: 1200, file: "b.mp3" },
    ], 10000);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ startMs: 1000, endMs: 2500, atempo: 1 });
    expect(p[1]).toMatchObject({ startMs: 5000, endMs: 6200, atempo: 1 });
  });

  it("speeds up an over-long clip just enough to fit before the next segment", () => {
    // 4s of speech must fit a 2s slot -> atempo 2 exactly.
    const p = planPlacement([
      { startMs: 0, endMs: 2000, text: "长句", synthMs: 4000, file: "a.mp3" },
      { startMs: 2000, endMs: 4000, text: "下句", synthMs: 1000, file: "b.mp3" },
    ], 10000);
    expect(p[0].atempo).toBeCloseTo(2.0, 3);
    expect(p[0].endMs).toBeCloseTo(2000, 0);
    // The next clip still starts on time, no overlap.
    expect(p[1].startMs).toBe(2000);
  });

  it("caps the speedup and nudges the successor instead of talking over it", () => {
    // 10s of speech into a 2s slot: atempo caps at MAX_ATEMPO and the next
    // clip starts after the bleed rather than overlapping.
    const p = planPlacement([
      { startMs: 0, endMs: 2000, text: "超长", synthMs: 10000, file: "a.mp3" },
      { startMs: 2000, endMs: 3000, text: "下句", synthMs: 1000, file: "b.mp3" },
    ], 30000);
    expect(p[0].atempo).toBe(MAX_ATEMPO);
    expect(p[0].endMs).toBeCloseTo(5000, 0);
    expect(p[1].startMs).toBeGreaterThanOrEqual(p[0].endMs);
  });

  it("gives the last clip tail room but caps the speedup at MAX_ATEMPO", () => {
    const p = planPlacement([
      { startMs: 8000, endMs: 9000, text: "结尾", synthMs: 4000, file: "a.mp3" },
    ], 9000);
    // Slot = film end - start = 1s; 4s of speech into 1s caps at 2x.
    expect(p[0].atempo).toBe(MAX_ATEMPO);
    expect(p[0].endMs).toBeCloseTo(8000 + 4000 / 2, 0);
    // A short final clip gets proportional room and stays atempo 1.
    const q = planPlacement([
      { startMs: 8000, endMs: 9000, text: "结尾", synthMs: 2000, file: "a.mp3" },
    ], 30000);
    expect(q[0].atempo).toBe(1);
  });

  it("drops nothing but never yields overlapping placements", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      startMs: i * 1000, endMs: i * 1000 + 900, text: `t${i}`, synthMs: 1100 + i * 10, file: `f${i}.mp3`,
    }));
    const p = planPlacement(items, 30000);
    for (let i = 1; i < p.length; i++) {
      expect(p[i].startMs).toBeGreaterThanOrEqual(p[i - 1].endMs - 0.001);
    }
  });

  it("subtitle segments mirror the placement clock and keep the cleaned text", () => {
    const subs = placementsToSubtitleSegments([
      { file: "a", text: "欢迎观看", startMs: 500, endMs: 1800.5, atempo: 1 },
      { file: "b", text: "  ", startMs: 2000, endMs: 2600, atempo: 1 },
    ]);
    expect(subs).toEqual([{ startMs: 500, endMs: 1801, text: "欢迎观看" }]);
  });
});
