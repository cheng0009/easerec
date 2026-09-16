/**
 * Pure text helpers for the floating teleprompter (no store/bridge imports so
 * they stay unit-testable in node).
 */

/** Split script text into paragraphs (blank-line separated), trimmed, with
 *  in-paragraph line breaks coerced to single spaces. */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

/** Normalize pasted/imported script text: CRLF→LF, strip BOM, collapse runs of
 *  three or more blank lines into the single blank line the prompter uses as a
 *  paragraph separator. Trailing whitespace is trimmed. */
export function normalizeScriptText(text: string): string {
  const t = (text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  return t.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}

export function clampFontSize(v: number): number {
  return Math.min(200, Math.max(10, Math.round(Number(v) || 56)));
}

export function clampSpeed(v: number): number {
  return Math.max(0, Number(v) || 0);
}