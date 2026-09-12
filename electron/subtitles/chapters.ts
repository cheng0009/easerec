/**
 * Chapter + metadata generation. Runs after the transcript exists: sends the
 * (already LLM-corrected) transcript to the online LLM and expects strict JSON
 * back with chapter timestamps, a title, a description and tags ready to paste
 * into B站/YouTube upload forms. Validation failure -> null (UI falls back to
 * "copy the transcript instead").
 */

import type { LlmConfig } from "./llm";

export interface Chapter {
  timeMs: number;
  title: string;
}

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
  chapters: Chapter[];
}

const HHMMSS = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0
    ? `${h}:${mm}:${String(sec).padStart(2, "0")}`
    : `${mm}:${String(sec).padStart(2, "0")}`;
};

export function buildChaptersPrompt(segments: { startMs: number; text: string }[], glossary?: string): { system: string; user: string } {
  const system = [
    "你是视频运营助手。输入是一段教程录屏的字幕稿（带时间戳）。",
    "任务：为视频生成投稿信息，输出严格 JSON：",
    '{"title":"<20字内标题>","description":"<简介，2-4句，含要点>","tags":["<标签>",...],"chapters":[{"time":"m:ss","title":"<章节名>"}]}',
    "章节按内容自然分界，4-10 个；时间必须来自字幕稿中已有的时间点（取该章节第一句的时间）。",
    "除 JSON 外不要输出任何内容。",
    glossary?.trim() ? `热词表：${glossary.trim()}` : "",
  ].filter(Boolean).join("\n");
  const user = segments
    .map((s) => `${HHMMSS(s.startMs)} ${s.text}`)
    .join("\n");
  return { system, user };
}

/** Parse + validate the model response. Null on any contract violation. */
export function validateChaptersResponse(raw: string): VideoMetadata | null {
  let body = (raw || "").trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1].trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const description = typeof o.description === "string" ? o.description.trim() : "";
  const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === "string" && !!t.trim()) : [];
  if (!title || !description) return null;
  const chapters: Chapter[] = [];
  if (Array.isArray(o.chapters)) {
    for (const c of o.chapters) {
      if (!c || typeof c !== "object") continue;
      const time = (c as { time?: unknown }).time;
      const chTitle = (c as { title?: unknown }).title;
      if (typeof time !== "string" || typeof chTitle !== "string") continue;
      const ms = parseClock(time);
      if (ms === null || !chTitle.trim()) continue;
      chapters.push({ timeMs: ms, title: chTitle.trim() });
    }
  }
  return { title, description, tags: tags.slice(0, 12), chapters };
}

/** "m:ss" | "h:mm:ss" -> ms; null when malformed. */
export function parseClock(text: string): number | null {
  const m = (text || "").trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  if (m[3] !== undefined) return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
  return (+m[1] * 60 + +m[2]) * 1000;
}

/** Ask the LLM for metadata. Returns null on any failure (caller degrades). */
export async function generateVideoMetadata(
  segments: { startMs: number; text: string }[],
  config: LlmConfig,
  fetchFn: typeof fetch = fetch,
  glossary?: string,
): Promise<VideoMetadata | null> {
  if (!config.enabled || !config.apiKey || segments.length === 0) return null;
  const { system, user } = buildChaptersPrompt(segments, glossary || config.glossary);
  const url = config.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    return validateChaptersResponse(content);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Markdown rendering for the clipboard/file. */
export function metadataToMarkdown(meta: VideoMetadata): string {
  const lines = [
    `# ${meta.title}`,
    "",
    meta.description,
    "",
    `标签：${meta.tags.join(" / ")}`,
    "",
  ];
  if (meta.chapters.length) {
    lines.push("章节：", "");
    for (const c of meta.chapters) lines.push(`${HHMMSS(c.timeMs)} ${c.title}`);
  }
  return lines.join("\n");
}
