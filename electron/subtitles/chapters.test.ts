import { describe, expect, it, vi } from "vitest";
import {
  buildChaptersPrompt,
  generateVideoMetadata,
  metadataToMarkdown,
  parseClock,
  validateChaptersResponse,
} from "./chapters";

describe("parseClock", () => {
  it("parses m:ss and h:mm:ss", () => {
    expect(parseClock("0:30")).toBe(30000);
    expect(parseClock("12:05")).toBe(725000);
    expect(parseClock("1:02:03")).toBe(3723000);
  });

  it("rejects malformed clocks", () => {
    expect(parseClock("abc")).toBeNull();
    expect(parseClock("1:2:3:4")).toBeNull();
    expect(parseClock("")).toBeNull();
  });
});

describe("validateChaptersResponse", () => {
  const good = JSON.stringify({
    title: "10分钟学会录屏导播",
    description: "从安装到导出的完整流程。",
    tags: ["录屏", "教程"],
    chapters: [
      { time: "0:00", title: "开场" },
      { time: "1:30", title: "倒带功能" },
    ],
  });

  it("accepts a valid response", () => {
    const meta = validateChaptersResponse(good);
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe("10分钟学会录屏导播");
    expect(meta!.chapters[1].timeMs).toBe(90000);
  });

  it("tolerates markdown fences and prose", () => {
    const meta = validateChaptersResponse(`结果如下：\n${good}`);
    expect(meta).not.toBeNull();
  });

  it("rejects missing title/description", () => {
    expect(validateChaptersResponse('{"description":"x"}')).toBeNull();
    expect(validateChaptersResponse('{"title":"t"}')).toBeNull();
    expect(validateChaptersResponse("nope")).toBeNull();
  });

  it("drops malformed chapters but keeps valid metadata", () => {
    const meta = validateChaptersResponse(JSON.stringify({
      title: "T", description: "D",
      chapters: [{ time: "bad", title: "x" }, { time: "0:10" }, { time: "0:20", title: "ok" }],
    }));
    expect(meta!.chapters).toEqual([{ timeMs: 20000, title: "ok" }]);
  });
});

describe("generateVideoMetadata", () => {
  it("returns null when disabled or segments empty", async () => {
    const cfg = { baseUrl: "x", apiKey: "k", model: "m", enabled: false };
    expect(await generateVideoMetadata([{ startMs: 0, text: "a" }], cfg)).toBeNull();
    expect(await generateVideoMetadata([], { ...cfg, enabled: true })).toBeNull();
  });

  it("returns metadata on a valid response and includes glossary in prompt", async () => {
    const fetchOk = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.messages[0].content).toContain("热词表：微码");
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({
            title: "微码教程",
            description: "D",
            tags: ["a"],
            chapters: [{ time: "0:00", title: "开场" }],
          }) } }],
        }),
      };
    });
    const cfg = { baseUrl: "https://x/v1", apiKey: "k", model: "m", enabled: true, glossary: "微码" };
    const meta = await generateVideoMetadata([{ startMs: 0, text: "开场白" }], cfg, fetchOk as unknown as typeof fetch);
    expect(meta!.title).toBe("微码教程");
  });

  it("returns null when the network fails", async () => {
    const fetchFail = vi.fn().mockRejectedValue(new Error("down"));
    const cfg = { baseUrl: "x", apiKey: "k", model: "m", enabled: true };
    expect(await generateVideoMetadata([{ startMs: 0, text: "a" }], cfg, fetchFail as unknown as typeof fetch)).toBeNull();
  });
});

describe("buildChaptersPrompt / markdown", () => {
  it("formats the transcript with timestamps", () => {
    const { user } = buildChaptersPrompt([{ startMs: 90000, text: "第二部分" }]);
    expect(user).toContain("1:30 第二部分");
  });

  it("renders markdown with chapters", () => {
    const md = metadataToMarkdown({
      title: "T", description: "D", tags: ["a", "b"],
      chapters: [{ timeMs: 61000, title: "第二章节" }],
    });
    expect(md).toContain("# T");
    expect(md).toContain("1:01 第二章节");
    expect(md).toContain("标签：a / b");
  });
});
