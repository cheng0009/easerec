/**
 * Hotword extraction — mine a finished transcript for proper nouns (brands,
 * people, jargon, likely homophone victims) so the glossary builds itself
 * from "what the ASR actually struggled with" instead of being typed by hand.
 */

export interface HotwordLlmConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Current glossary — its terms are excluded from suggestions. */
  glossary?: string;
}

export function buildHotwordSystemPrompt(): string {
  return [
    "你是热词提取助手。输入是一段视频的语音识别转写文本。",
    "任务：找出值得加入「热词表」的词，用于后续语音识别偏置与字幕校正。规则：",
    "1. 只收：品牌/产品名、人名/昵称、公司/项目名、技术术语、英文缩写，以及转写中疑似同音错字的高频词（如人名被写成了别字）；",
    "2. 不收：普通词汇、日常用语、转写已经正确的常见词；",
    "3. 每个词输出它的标准书写形式（即希望最终出现在字幕里的样子）；",
    '4. 输出严格 JSON：{"hotwords":["词1","词2"]}，除 JSON 外不要输出任何内容；最多 30 个，按重要程度排序。',
  ].join("\n");
}

/** Parse the model reply; tolerate fences/prose around the JSON object. */
export function validateHotwordResponse(content: string, existing: Set<string>): string[] {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return []; }
  const arr = (parsed as { hotwords?: unknown })?.hotwords;
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const raw of arr) {
    if (typeof raw !== "string") continue;
    const w = raw.trim();
    if (!w || w.length > 40 || existing.has(w) || out.includes(w)) continue;
    out.push(w);
  }
  return out.slice(0, 30);
}

/** Ask the LLM to propose hotwords; null on any failure (guarded feature). */
export async function extractHotwords(
  segments: { text: string }[],
  config: HotwordLlmConfig,
  fetchFn: typeof fetch = fetch,
): Promise<string[] | null> {
  if (!config.enabled || !config.apiKey || segments.length === 0) return null;
  // Long recordings: the head of the transcript carries most recurring terms;
  // the cap keeps the request cheap and predictable.
  const text = segments.map((s) => s.text).join("\n").slice(0, 12000);
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
          { role: "system", content: buildHotwordSystemPrompt() },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const existing = new Set((config.glossary || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    return validateHotwordResponse(content, existing);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
