/**
 * Transcript -> subtitle cues. Whisper segments are often long paragraphs;
 * subtitle display needs short cues. This module:
 *   1. parses whisper.cpp JSON output (-oj) into segments,
 *   2. splits long segments on punctuation (CJK + latin) under per-language
 *      character limits, keeping timestamps proportional to character counts,
 *   3. drops empty/noise-only cues.
 *
 * PURE module (the whisper.cpp CLI wrapper lives in whisper.ts).
 */

export interface WhisperSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface CueOptions {
  /** Max characters per cue (CJK counts double-width; see charLen). */
  maxChars?: number;
  /** Min cue duration ms. */
  minDurationMs?: number;
  /** Max cue duration ms (forced split even without punctuation). */
  maxDurationMs?: number;
}

/** Display length: CJK ideographs/fullwidth punctuation count double. */
export function charLen(text: string): number {
  let n = 0;
  for (const ch of text) n += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 2 : 1;
  return n;
}

const SPLIT_RE = /(?<=[。！？；!?;])|(?<=，,)(?=\s*$)|(?<=[，,])|(?<=\.)(?=\s)|(?<=…)/;

/** Split one segment's text into cue-sized chunks on punctuation. */
export function splitSegmentText(text: string, maxChars: number): string[] {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const parts = clean.split(SPLIT_RE).map((p) => p.trim()).filter(Boolean);
  // Greedily pack punctuation chunks into cues up to maxChars.
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if (!cur) {
      cur = p;
    } else if (charLen(cur + p) <= maxChars) {
      cur += p;
    } else {
      out.push(cur);
      cur = p;
    }
    // Hard split of an oversized single chunk (no punctuation anywhere).
    while (charLen(cur) > maxChars) {
      let cut = 0;
      let len = 0;
      for (const ch of cur) {
        const w = charLen(ch);
        if (len + w > maxChars) break;
        len += w;
        cut += ch.length;
      }
      out.push(cur.slice(0, cut).trim());
      cur = cur.slice(cut).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Convert whisper segments into display cues. A segment shorter than the
 * limits stays one cue; long segments split proportionally to display length.
 */
export function segmentsToCues(segments: WhisperSegment[], opts: CueOptions = {}): WhisperSegment[] {
  const maxChars = opts.maxChars ?? 24;
  const minDur = opts.minDurationMs ?? 700;
  const maxDur = opts.maxDurationMs ?? 6000;
  const cues: WhisperSegment[] = [];

  for (const seg of segments) {
    const text = (seg.text || "").trim();
    if (!text) continue;
    if (/^[\s(\[（【]*(嗯|啊|呃|em+|uh+|um+|uhm)[\s)\]）】]*$/i.test(text)) continue; // pure filler

    const dur = Math.max(1, seg.endMs - seg.startMs);
    const chunks = splitSegmentText(text, maxChars);
    if (chunks.length <= 1) {
      const end = Math.min(seg.endMs, seg.startMs + Math.max(dur, minDur));
      cues.push({ startMs: seg.startMs, endMs: end, text });
      continue;
    }
    const totalChars = chunks.reduce((a, c) => a + charLen(c), 0);
    // Proportional boundaries across the segment's window.
    let acc = 0;
    const bounds: { start: number; end: number }[] = [];
    chunks.forEach((chunk, i) => {
      acc += charLen(chunk);
      const end = seg.startMs + (dur * acc) / totalChars;
      bounds.push({ start: i === 0 ? seg.startMs : bounds[i - 1].end, end });
    });
    chunks.forEach((chunk, i) => {
      let start = bounds[i].start;
      let end = bounds[i].end;
      if (end - start < minDur) end = Math.min(seg.endMs, start + minDur);
      if (end - start > maxDur) end = start + maxDur;
      cues.push({ startMs: Math.round(start), endMs: Math.round(end), text: chunk });
    });
  }

  // Fix overlaps introduced by minDuration nudging.
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].startMs < cues[i - 1].endMs) {
      cues[i - 1].endMs = Math.max(cues[i].startMs, cues[i - 1].startMs + 100);
    }
  }
  return cues;
}

// ---------------------------------------------------------------------------
// whisper.cpp JSON parsing (-oj)
// ---------------------------------------------------------------------------

interface WhisperJsonEntry {
  timestamps?: { from?: string; to?: string };
  offsets?: { from?: number; to?: number };
  text?: string;
}

/** Parse the JSON file written by `whisper-cli -oj`. */
export function parseWhisperJson(raw: string): WhisperSegment[] {
  let data: { transcription?: WhisperJsonEntry[] };
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return [];
  }
  const rows = Array.isArray(data?.transcription) ? data.transcription : [];
  const out: WhisperSegment[] = [];
  for (const r of rows) {
    const startMs = Number(r?.offsets?.from);
    const endMs = Number(r?.offsets?.to);
    const text = String(r?.text ?? "").trim();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !text) continue;
    out.push({ startMs, endMs, text });
  }
  return out;
}

/**
 * Fallback parser for whisper.cpp plain-text output (SRT-ish blocks) when
 * -oj is unavailable. `mm:ss,ms --> mm:ss,ms` blocks.
 */
export function parseWhisperSrt(raw: string): WhisperSegment[] {
  const out: WhisperSegment[] = [];
  const re = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*\n([\s\S]*?)(?=\n\s*\n|\n\d+\s*\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const [, h1, m1, s1, ms1, h2, m2, s2, ms2, text] = m;
    const startMs = +h1 * 3600000 + +m1 * 60000 + +s1 * 1000 + Number(ms1.padEnd(3, "0"));
    const endMs = +h2 * 3600000 + +m2 * 60000 + +s2 * 1000 + Number(ms2.padEnd(3, "0"));
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) out.push({ startMs, endMs, text: clean });
  }
  return out;
}
