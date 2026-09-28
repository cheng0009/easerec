/**
 * MiniMax TTS client — the network layer behind AI 换声 (voice swap).
 *
 * Protocol notes (verified against the open-platform docs):
 *   - POST {base}/v1/t2a_v2, Authorization: Bearer <apiKey>.
 *     Response carries the audio HEX-encoded in data.audio (NOT base64) plus
 *     extra_info.audio_length in ms — the duration comes free, no probe pass.
 *   - base_resp.status_code: 0 = ok; 1002/1039 = rate limited (retryable);
 *     1004 = bad key; 1008 = out of balance.
 *   - Voice cloning is TWO steps: upload the sample (multipart,
 *     purpose=voice_clone) -> file_id, then POST /v1/voice_clone with a
 *     caller-chosen voice_id (8..256 chars, leading letter). A cloned voice
 *     the user never synthesizes with for 7 days is reclaimed by the platform.
 *
 * fetch is injectable so every code path stays unit-testable offline.
 */

export interface MinimaxConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const MINIMAX_CN_BASE = "https://api.minimax.cn";
export const MINIMAX_INTL_BASE = "https://api.minimaxi.com";

/** Model choices surfaced in the UI — turbo balances speed/cost for dozens
 *  of small per-segment calls; hd for the final-polish crowd. */
export const MINIMAX_MODEL_OPTIONS = [
  { id: "speech-02-turbo", label: "速度优先（turbo，推荐）" },
  { id: "speech-02-hd", label: "音质优先（hd）" },
] as const;

/** A small curated set of Mandarin system voices good for teaching videos.
 *  Shared with the renderer via src/lib/constants.ts. */
import { MINIMAX_PRESET_VOICES } from "../../src/lib/constants";
export { MINIMAX_PRESET_VOICES };

export interface TtsResult {
  /** Decoded mp3 audio. */
  audio: Buffer;
  /** Reported synthesis duration (extra_info.audio_length), ms. */
  durationMs: number;
}

export class MinimaxError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    // 1002/1039 are MiniMax rate-limit codes; <1000 values are HTTP statuses
    // (5xx transport blips). The 4-digit base_resp codes are NOT >= 500-safe.
    this.retryable = statusCode === 1002 || statusCode === 1039 ||
      (statusCode >= 500 && statusCode < 1000);
  }
}

function baseUrlOf(cfg: MinimaxConfig): string {
  return (cfg.baseUrl || MINIMAX_CN_BASE).replace(/\/+$/, "");
}

interface T2aResponse {
  data?: { audio?: string };
  extra_info?: { audio_length?: number };
  base_resp?: { status_code?: number; status_msg?: string };
}

/** Synthesize one text chunk with the configured voice. */
export async function minimaxTts(
  cfg: MinimaxConfig,
  text: string,
  voiceId: string,
  opts: { speed?: number; fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<TtsResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetchFn(`${baseUrlOf(cfg)}/v1/t2a_v2`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model || "speech-02-turbo",
        text,
        stream: false,
        voice_setting: {
          voice_id: voiceId,
          speed: opts.speed ?? 1.0,
          vol: 1.0,
          pitch: 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: "mp3",
          channel: 1,
        },
      }),
    });
    if (!res.ok) throw new MinimaxError(res.status, `MiniMax HTTP ${res.status}`);
    const data = (await res.json()) as T2aResponse;
    const st = data.base_resp?.status_code ?? -1;
    if (st !== 0) {
      throw new MinimaxError(st, data.base_resp?.status_msg || `MiniMax status ${st}`);
    }
    const hex = data.data?.audio ?? "";
    if (!hex) throw new MinimaxError(-1, "MiniMax returned no audio");
    const audio = Buffer.from(hex, "hex");
    if (audio.length === 0) throw new MinimaxError(-1, "MiniMax audio hex decoded empty");
    return { audio, durationMs: Math.max(0, Math.round(data.extra_info?.audio_length ?? 0)) };
  } finally {
    clearTimeout(timer);
  }
}

/** Real-connection test: synthesize a 6-char sample (cheapest possible call). */
export async function minimaxTestConnection(
  cfg: MinimaxConfig,
  voiceId: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string; durationMs: number }> {
  try {
    const r = await minimaxTts(cfg, "连接测试。", voiceId || MINIMAX_PRESET_VOICES[0].id, { fetchFn, timeoutMs: 30_000 });
    return { ok: true, detail: `✓ ${L_OK(cfg)}（${(r.durationMs / 1000).toFixed(1)}s 音频）`, durationMs: r.durationMs };
  } catch (e) {
    return { ok: false, detail: `✗ ${friendlyError(e)}`, durationMs: 0 };
  }
}

function L_OK(cfg: MinimaxConfig): string {
  return `MiniMax 连接正常（${cfg.model || "speech-02-turbo"}）`;
}

/** Map MiniMax status codes to actionable Chinese hints. */
export function friendlyError(e: unknown): string {
  if (e instanceof MinimaxError) {
    if (e.statusCode === 1004) return "API Key 无效或未授权（1004）";
    if (e.statusCode === 1008) return "账户余额不足（1008）";
    if (e.statusCode === 1002 || e.statusCode === 1039) return `请求过于频繁（${e.statusCode}），稍后重试`;
    return `${e.message}（${e.statusCode}）`;
  }
  return String((e as Error)?.message ?? e);
}

// ---------------------------------------------------------------------------
// Voice cloning (two steps)
// ---------------------------------------------------------------------------

/** Build a multipart/form-data body by hand — the main process cannot rely
 *  on DOM FormData and staying buffer-level keeps this deterministic. */
function multipartBody(fields: Record<string, string>, fileField: string, fileName: string, fileBuf: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----easerec${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  const enc = (s: string): Buffer => Buffer.from(s, "utf8");
  for (const [k, v] of Object.entries(fields)) {
    parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(fileBuf, enc(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Random voice_id that satisfies the platform rules (letter first, 8+). */
export function newCloneVoiceId(): string {
  const abc = "abcdefghjkmnpqrstuvwxyz";
  const rnd = () => abc[Math.floor(Math.random() * abc.length)];
  const tail = Array.from({ length: 10 }, () => (Math.random() < 0.5 ? rnd() : String(Math.floor(Math.random() * 10)))).join("");
  return `easerec${tail}`;
}

/** Step 1: upload the voice sample -> file_id. */
async function uploadCloneAudio(
  cfg: MinimaxConfig,
  audioPath: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const fs = await import("node:fs");
  const buf = fs.readFileSync(audioPath);
  const { body, contentType } = multipartBody({ purpose: "voice_clone" }, "file", "voice_sample", buf);
  const res = await fetchFn(`${baseUrlOf(cfg)}/v1/files/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": contentType },
    body: body as unknown as BodyInit,
  });
  if (!res.ok) throw new MinimaxError(res.status, `upload HTTP ${res.status}`);
  const data = (await res.json()) as { file?: { file_id?: string }; base_resp?: { status_code?: number; status_msg?: string } };
  const st = data.base_resp?.status_code ?? -1;
  if (st !== 0) throw new MinimaxError(st, data.base_resp?.status_msg || `upload status ${st}`);
  const fileId = data.file?.file_id;
  if (!fileId) throw new MinimaxError(-1, "upload returned no file_id");
  return fileId;
}

/** Full clone: upload the sample, then register it under a fresh voice_id.
 *  The id is returned so the UI can select + persist it. */
export async function minimaxCloneVoice(
  cfg: MinimaxConfig,
  audioPath: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ voiceId: string }> {
  const fileId = await uploadCloneAudio(cfg, audioPath, fetchFn);
  const voiceId = newCloneVoiceId();
  const res = await fetchFn(`${baseUrlOf(cfg)}/v1/voice_clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ file_id: fileId, voice_id: voiceId }),
  });
  if (!res.ok) throw new MinimaxError(res.status, `clone HTTP ${res.status}`);
  const data = (await res.json()) as { base_resp?: { status_code?: number; status_msg?: string } };
  const st = data.base_resp?.status_code ?? -1;
  if (st !== 0) throw new MinimaxError(st, data.base_resp?.status_msg || `clone status ${st}`);
  return { voiceId };
}
