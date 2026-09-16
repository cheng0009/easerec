import { describe, expect, it, vi } from "vitest";
import {
  alignmentFor,
  assTime,
  escapeAssText,
  generateAss,
  toAssColor,
} from "./ass";
import {
  charLen,
  parseWhisperJson,
  parseWhisperSrt,
  segmentsToCues,
  splitSegmentText,
  type WhisperSegment,
} from "./cues";
import {
  applyCorrections,
  batchSegments,
  buildCorrectionSystemPrompt,
  buildCorrectionUserPrompt,
  correctTranscript,
  testLlmConnection,
  validateCorrectionResponse,
  type IndexedSegment,
} from "./llm";
import { buildWhisperArgs } from "./whisper";

// ---------------------------------------------------------------------------
// ASS
// ---------------------------------------------------------------------------

describe("ASS generation", () => {
  const style = {
    fontFamily: "Microsoft YaHei", fontSize: 28, color: "#FFFFFF",
    outlineColor: "#000000", outlineWidth: 2, position: "bottom" as const, marginV: 40,
  };

  it("maps colors to &HAABBGGRR", () => {
    expect(toAssColor("#FF0000")).toBe("&H000000FF"); // red -> BB GG RR = 00 00 FF
    expect(toAssColor("#00FF7F", 0.5)).toBe("&H807FFF00");
  });

  it("formats the centisecond clock", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(3723456)).toBe("1:02:03.45");
  });

  it("maps positions to numpad alignment", () => {
    expect(alignmentFor("bottom")).toBe(2);
    expect(alignmentFor("middle")).toBe(5);
    expect(alignmentFor("top")).toBe(8);
  });

  it("escapes braces/slashes and converts newlines", () => {
    expect(escapeAssText("a{b}c\nd/e")).toBe("a｛b｝c\\Nd／e");
  });

  it("generates a style line and dialogue events", () => {
    const ass = generateAss(
      [
        { startMs: 1000, endMs: 2500, text: "大家好" },
        { startMs: 3000, endMs: 4000, text: "" }, // dropped
        { startMs: 5000, endMs: 6000, text: "今天讲 {WebCodecs}" },
      ],
      style,
      { width: 1920, height: 1080 },
    );
    // PlayRes uses a 192-unit reference height (matches preview coordinate system).
    expect(ass).toContain("PlayResX: 341"); // 1920 * 192 / 1080 ≈ 341
    expect(ass).toContain("PlayResY: 192");
    expect(ass).toContain("Style: DCSub, Microsoft YaHei, 28, &H00FFFFFF");
    expect(ass).toContain("Dialogue: 0,0:00:01.00,0:00:02.50,DCSub,,0,0,0,,大家好");
    expect(ass).not.toContain("0:00:03.00"); // empty cue dropped
    expect(ass).toContain("今天讲 ｛WebCodecs｝");
    // bottom alignment lands at the end of the style line
    expect(ass).toContain(", 2, 40, 40, 40, 1");
  });
});

// ---------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------

describe("cue splitting", () => {
  it("counts CJK as double width", () => {
    expect(charLen("abc")).toBe(3);
    expect(charLen("你好")).toBe(4);
    expect(charLen("你好world")).toBe(9); // 2 CJK = 4 + 5 latin
  });

  it("splits long Chinese segments on sentence punctuation", () => {
    const parts = splitSegmentText("今天我们讲导播。这个功能很实用！那我们开始吧。", 20);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe("今天我们讲导播。这个功能很实用！那我们开始吧。");
  });

  it("hard-splits oversized chunks without punctuation", () => {
    const parts = splitSegmentText("A".repeat(50), 20);
    expect(parts).toHaveLength(3);
    parts.forEach((p) => expect(charLen(p)).toBeLessThanOrEqual(20));
  });

  it("keeps timestamps proportional and within the segment window", () => {
    const segs: WhisperSegment[] = [
      { startMs: 1000, endMs: 5000, text: "第一句话。第二句话稍微长一点。第三句。" },
    ];
    const cues = segmentsToCues(segs, { maxChars: 8 });
    expect(cues.length).toBeGreaterThanOrEqual(3);
    expect(cues[0].startMs).toBe(1000);
    expect(cues[cues.length - 1].endMs).toBeLessThanOrEqual(5000);
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].startMs).toBeGreaterThanOrEqual(cues[i - 1].endMs - 1);
    }
    cues.forEach((c) => expect(c.endMs - c.startMs).toBeLessThanOrEqual(6100));
  });

  it("extends very short cues to the minimum duration", () => {
    const cues = segmentsToCues([{ startMs: 0, endMs: 200, text: "好。" }]);
    expect(cues[0].endMs - cues[0].startMs).toBeGreaterThanOrEqual(200);
  });

  it("drops pure filler segments", () => {
    const cues = segmentsToCues([
      { startMs: 0, endMs: 500, text: "呃" },
      { startMs: 500, endMs: 1000, text: "emmm" },
      { startMs: 1000, endMs: 2000, text: "真正的第一句" },
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("真正的第一句");
  });
});

describe("whisper output parsing", () => {
  it("parses whisper.cpp -oj JSON", () => {
    const json = JSON.stringify({
      transcription: [
        { timestamps: { from: "00:00:00", to: "00:00:02" }, offsets: { from: 0, to: 2000 }, text: " 大家好" },
        { offsets: { from: 2000, to: 4500 }, text: " 今天讲导播。" },
        { offsets: { from: 9999, to: 12345 }, text: "   " },
      ],
    });
    const segs = parseWhisperJson(json);
    expect(segs).toHaveLength(2);
    expect(segs[1]).toEqual({ startMs: 2000, endMs: 4500, text: "今天讲导播。" });
  });

  it("parses SRT-style fallback output", () => {
    const srt = "1\n00:00:01,000 --> 00:00:03,500\n你好世界\n\n2\n00:00:04,000 --> 00:00:05,000\n第二句\n";
    const segs = parseWhisperSrt(srt);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ startMs: 1000, endMs: 3500, text: "你好世界" });
  });

  it("returns empty on garbage input", () => {
    expect(parseWhisperJson("not json")).toEqual([]);
    expect(parseWhisperSrt("no timestamps here")).toEqual([]);
  });

  it("builds whisper args with glossary prompt and language", () => {
    const args = buildWhisperArgs("a.wav", "out/asr", "m.bin", { language: "zh", glossary: "DeepSeek, Koffi" });
    expect(args).toContain("-m");
    expect(args.join(" ")).toContain("术语表：DeepSeek, Koffi");
    expect(args).toContain("-l");
    expect(args.slice(args.indexOf("-l") + 1, args.indexOf("-l") + 2)).toEqual(["zh"]);
  });
});

// ---------------------------------------------------------------------------
// LLM correction
// ---------------------------------------------------------------------------

describe("LLM correction", () => {
  const segs: IndexedSegment[] = [
    { id: 0, text: "今天讲伟码" },
    { id: 1, text: "首先看架构" },
  ];

  it("validates a correct response", () => {
    const raw = JSON.stringify({ segments: [{ id: 1, text: "首先看架构" }, { id: 0, text: "今天讲微码" }] });
    expect(validateCorrectionResponse(raw, segs)).toEqual([
      { id: 0, text: "今天讲微码" },
      { id: 1, text: "首先看架构" },
    ]);
  });

  it("rejects when ids are added/removed/duplicated", () => {
    expect(validateCorrectionResponse(JSON.stringify({ segments: [{ id: 0, text: "x" }] }), segs)).toBeNull();
    expect(validateCorrectionResponse(
      JSON.stringify({ segments: [{ id: 0, text: "x" }, { id: 1, text: "y" }, { id: 2, text: "z" }] }), segs,
    )).toBeNull();
    expect(validateCorrectionResponse(
      JSON.stringify({ segments: [{ id: 0, text: "x" }, { id: 0, text: "dup" }, { id: 1, text: "y" }] }), segs,
    )).toBeNull();
    expect(validateCorrectionResponse("完全不包含JSON", segs)).toBeNull();
    // Tolerates markdown fences and prose.
    const fenced = "好的，以下是结果：\n```json\n{\"segments\":[{\"id\":0,\"text\":\"今天讲微码\"},{\"id\":1,\"text\":\"首先看架构\"}]}\n```";
    expect(validateCorrectionResponse(fenced, segs)).toHaveLength(2);
  });

  it("falls back to originals when disabled or the network fails", async () => {
    const disabled = await correctTranscript(segs, { baseUrl: "", apiKey: "", model: "", enabled: false });
    expect(disabled).toEqual([
      { id: 0, text: "今天讲伟码", corrected: false },
      { id: 1, text: "首先看架构", corrected: false },
    ]);
    const fetchFail = vi.fn().mockRejectedValue(new Error("network down"));
    const cfg = { baseUrl: "https://x/v1", apiKey: "k", model: "m", enabled: true };
    const failed = await correctTranscript(segs, cfg, fetchFail as unknown as typeof fetch);
    expect(failed.every((s) => s.corrected === false)).toBe(true);
  });

  it("applies corrections per batch and preserves ordering on success", async () => {
    const responses = [
      JSON.stringify({ segments: [{ id: 0, text: "今天讲微码" }, { id: 1, text: "首先看架构" }] }),
      JSON.stringify({ segments: [{ id: 2, text: "然后看实现" }] }),
    ];
    let call = 0;
    const fetchOk = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: responses[call++] } }] }),
    }));
    const three: IndexedSegment[] = [...segs, { id: 2, text: "然后看实现" }];
    const cfg = { baseUrl: "https://x/v1", apiKey: "k", model: "m", enabled: true, glossary: "微码" };
    const out = await correctTranscript(three, cfg, fetchOk as unknown as typeof fetch, { batchSize: 2 });
    expect(out.map((s) => s.text)).toEqual(["今天讲微码", "首先看架构", "然后看实现"]);
    expect(out.every((s) => s.corrected)).toBe(true);
    // The system prompt carries the glossary.
    const body = JSON.parse((fetchOk.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content).toContain("热词表（专有名词，必须保持原样）：微码");
  });

  it("falls back per batch when one batch response is invalid", async () => {
    let call = 0;
    const responses = ["垃圾回复", JSON.stringify({ segments: [{ id: 2, text: "然后看实现" }] })];
    const fetchOk = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: responses[call++] } }] }),
    }));
    const three: IndexedSegment[] = [...segs, { id: 2, text: "然后看实现" }];
    const out = await correctTranscript(three, { baseUrl: "x", apiKey: "k", model: "m", enabled: true }, fetchOk as unknown as typeof fetch, { batchSize: 2 });
    expect(out[0].corrected).toBe(false);
    expect(out[0].text).toBe("今天讲伟码");
    expect(out[2].corrected).toBe(true);
  });

  it("batches segments and builds prompts", () => {
    expect(batchSegments([1, 2, 3, 4, 5].map((i) => ({ id: i, text: "t" })), 2)).toHaveLength(3);
    expect(buildCorrectionSystemPrompt("ABC").split("\n").join(" ")).toContain("热词表（专有名词，必须保持原样）：ABC");
    expect(buildCorrectionUserPrompt([{ id: 3, text: "x" }])).toContain("3: x");
  });

  it("applyCorrections swaps text by index", () => {
    const timed = [{ startMs: 0, endMs: 1000, text: "a" }, { startMs: 1, endMs: 2000, text: "b" }];
    const out = applyCorrections(timed, [{ id: 1, text: "B" }]);
    expect(out[1].text).toBe("B");
    expect(out[0].text).toBe("a");
  });

  it("testLlmConnection reports success with latency", async () => {
    const fetchOk = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "OK" } }] }),
    });
    const res = await testLlmConnection(
      { baseUrl: "https://x/v1", apiKey: "k", model: "m", enabled: true },
      fetchOk as unknown as typeof fetch,
    );
    expect(res.ok).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    const url = (fetchOk.mock.calls[0][0] as string);
    expect(url).toContain("/chat/completions");
  });

  it("testLlmConnection behaves on missing key / auth / timeout", async () => {
    const noKey = await testLlmConnection({ baseUrl: "https://x/v1", apiKey: "", model: "m", enabled: true });
    expect(noKey.ok).toBe(false);
    expect(noKey.detail).toContain("API Key");

    const fetch401 = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized" });
    const auth = await testLlmConnection(
      { baseUrl: "https://x/v1", apiKey: "bad", model: "m", enabled: true },
      fetch401 as unknown as typeof fetch,
    );
    expect(auth.ok).toBe(false);
    expect(auth.detail).toContain("鉴权");

    const fetchSlow = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      await new Promise((r) => setTimeout(r, 500));
      const signal = (init.signal as AbortSignal | undefined);
      if (signal?.aborted) throw new Error("aborted");
      throw new Error("timed out");
    });
    const slow = await testLlmConnection(
      { baseUrl: "https://x/v1", apiKey: "k", model: "m", enabled: true },
      fetchSlow as unknown as typeof fetch,
      100,
    );
    expect(slow.ok).toBe(false);
  });
});
