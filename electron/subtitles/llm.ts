/**
 * Online LLM correction of ASR transcripts (OpenAI-compatible /chat/completions).
 *
 * The hard design rule: the model may only REWRITE the text of each segment —
 * it must never add, remove, merge or reorder segments, so the local timestamps
 * survive untouched. Requests are batched (~40 segments), responses are
 * validated (id set must match exactly) and any failure falls back to the
 * original text for that batch. A network outage therefore degrades to plain
 * whisper output, never breaks the export.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  glossary?: string;
}

export interface IndexedSegment {
  id: number;
  text: string;
}

export interface CorrectedSegment extends IndexedSegment {
  /** false when this segment fell back to the original ASR text */
  corrected?: boolean;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
  enabled: false,
};

export const BATCH_SIZE = 40;

export function buildCorrectionSystemPrompt(glossary?: string): string {
  return [
    "你是视频字幕校对员。输入是语音识别(ASR)输出的分段文本，每段有唯一 id。",
    "任务：修正每段文本中的错别字、同音字错误、标点，使语句通顺自然。",
    "规则（必须严格遵守）：",
    "1. 只改写每段自身的文本，绝不增加、删除、合并或拆分段落；",
    "2. 不改写专有名词的拼写，除非明显是同音错字；",
    "3. 保留口语语气，不要润色成书面语；",
    "4. 输出严格的 JSON：{\"segments\":[{\"id\":<原id>,\"text\":\"<改写后文本>\"}]}，id 集合必须与输入完全一致；",
    "5. 除 JSON 外不要输出任何内容。",
    glossary?.trim() ? `热词表（专有名词，必须保持原样）：${glossary.trim()}` : "",
  ].filter(Boolean).join("\n");
}

export function buildCorrectionUserPrompt(segments: IndexedSegment[], contextBefore?: string): string {
  const lines = segments.map((s) => `${s.id}: ${s.text}`);
  const ctx = contextBefore ? `（前文，供参考，不要输出：…${contextBefore}）\n` : "";
  return `${ctx}${lines.join("\n")}`;
}

/** Parse and validate a model response; null when the id set doesn't match. */
export function validateCorrectionResponse(
  raw: string,
  expected: IndexedSegment[],
): IndexedSegment[] | null {
  let body = (raw || "").trim();
  // Tolerate ```json fences.
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1].trim();
  // Tolerate prose around the first {...} block.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  const segs = (parsed as { segments?: unknown })?.segments;
  if (!Array.isArray(segs)) return null;
  const byId = new Map<number, string>();
  for (const s of segs) {
    if (!s || typeof s !== "object") return null;
    const id = (s as { id?: unknown }).id;
    const text = (s as { text?: unknown }).text;
    if (typeof id !== "number" || !Number.isInteger(id) || typeof text !== "string") return null;
    if (byId.has(id)) return null;
    byId.set(id, text);
  }
  const expectedIds = expected.map((s) => s.id).sort((a, b) => a - b);
  const gotIds = [...byId.keys()].sort((a, b) => a - b);
  if (expectedIds.length !== gotIds.length || expectedIds.some((v, i) => v !== gotIds[i])) return null;
  return expected.map((s) => ({ id: s.id, text: byId.get(s.id)! }));
}

export function batchSegments(segments: IndexedSegment[], size = BATCH_SIZE): IndexedSegment[][] {
  const out: IndexedSegment[][] = [];
  for (let i = 0; i < segments.length; i += size) out.push(segments.slice(i, i + size));
  return out;
}

export interface ChatResponse {
  content?: string;
}

async function callChat(
  config: LlmConfig,
  system: string,
  user: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const url = config.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("LLM empty response");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Correct all segments. Returns corrected texts where the model obeyed the
 * contract, originals wherever it (or the network) did not.
 */
export async function correctTranscript(
  segments: IndexedSegment[],
  config: LlmConfig,
  fetchFn: typeof fetch = fetch,
  opts: { batchSize?: number; timeoutMs?: number } = {},
): Promise<CorrectedSegment[]> {
  if (!config.enabled || !config.apiKey || segments.length === 0) {
    return segments.map((s) => ({ ...s, corrected: false }));
  }
  const system = buildCorrectionSystemPrompt(config.glossary);
  const batches = batchSegments(segments, opts.batchSize ?? BATCH_SIZE);
  const out: CorrectedSegment[] = [];
  for (const batch of batches) {
    const last = batch[batch.length - 1];
    const idx = segments.indexOf(last);
    const contextBefore = idx > 0 ? segments[idx - 1].text.slice(-30) : undefined;
    try {
      const raw = await callChat(config, system, buildCorrectionUserPrompt(batch, contextBefore), fetchFn, opts.timeoutMs ?? 60000);
      const fixed = validateCorrectionResponse(raw, batch);
      if (fixed) {
        for (const f of fixed) out.push({ ...f, corrected: true });
        continue;
      }
    } catch { /* fall back */ }
    for (const s of batch) out.push({ ...s, corrected: false });
  }
  // Preserve the original ordering (batches are processed in order, but be safe).
  const byId = new Map(out.map((s) => [s.id, s]));
  return segments.map((s) => byId.get(s.id) ?? { ...s, corrected: false });
}

/** Convert corrected segments back to timed segments. */
export function applyCorrections<T extends { startMs: number; endMs: number; text: string }>(
  timed: T[],
  corrections: CorrectedSegment[],
): T[] {
  const byId = new Map(corrections.map((c) => [c.id, c]));
  return timed.map((seg, i) => {
    const c = byId.get(i);
    return c ? { ...seg, text: c.text } : seg;
  });
}
