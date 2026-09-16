import { describe, expect, it } from "vitest";
import { splitParagraphs, normalizeScriptText, clampFontSize, clampSpeed } from "./teleprompterText";

describe("splitParagraphs", () => {
  it("splits on blank lines and trims each paragraph", () => {
    const text = "第一段标题\n第一段内容\n\n第二段\n\n\n第三段";
    expect(splitParagraphs(text)).toEqual(["第一段标题 第一段内容", "第二段", "第三段"]);
  });

  it("coerces in-paragraph newlines to single spaces", () => {
    expect(splitParagraphs("第 一 行\n  第二行  ")[0]).toBe("第 一 行 第二行");
  });

  it("drops empty paragraphs entirely", () => {
    expect(splitParagraphs("\n\n\n")).toEqual([]);
    expect(splitParagraphs("")).toEqual([]);
  });

  it("strips a leading BOM", () => {
    expect(splitParagraphs("\uFEFF你好")).toEqual(["你好"]);
  });
});

describe("normalizeScriptText", () => {
  it("converts CRLF and lone CR to LF", () => {
    expect(normalizeScriptText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("strips a leading BOM", () => {
    expect(normalizeScriptText("\uFEFF内容")).toBe("内容");
  });

  it("collapses runs of 3+ blank lines into a single paragraph break", () => {
    expect(normalizeScriptText("一\n\n\n\n\n二")).toBe("一\n\n二");
  });

  it("trims trailing whitespace", () => {
    expect(normalizeScriptText("  文字  \n \n ")).toBe("  文字");
  });

  it("handles empty and undefined-like input safely", () => {
    expect(normalizeScriptText("")).toBe("");
    expect(normalizeScriptText(undefined as unknown as string)).toBe("");
  });
});

describe("clampFontSize / clampSpeed", () => {
  it("clamps font size into 10..200 and rounds", () => {
    expect(clampFontSize(56)).toBe(56);
    expect(clampFontSize(5)).toBe(10);
    expect(clampFontSize(999)).toBe(200);
    expect(clampFontSize(56.6)).toBe(57);
    expect(clampFontSize(NaN)).toBe(56);
  });

  it("clamps speed to >= 0 and falls back to 0 on bad input", () => {
    expect(clampSpeed(12)).toBe(12);
    expect(clampSpeed(-3)).toBe(0);
    expect(clampSpeed(NaN)).toBe(0);
  });
});