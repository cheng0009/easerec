import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  friendlyError,
  MinimaxError,
  minimaxCloneVoice,
  minimaxTts,
  minimaxTestConnection,
  newCloneVoiceId,
} from "./minimax";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => Buffer.from("sample-bytes")),
}));

const CFG = { baseUrl: "https://api.minimax.cn", apiKey: "k", model: "speech-02-turbo" };

function ttsResponse(hex: string, audioLengthMs: number): Response {
  return new Response(JSON.stringify({
    data: { audio: hex },
    extra_info: { audio_length: audioLengthMs },
    base_resp: { status_code: 0, status_msg: "" },
  }), { status: 200 });
}

describe("minimax client", () => {
  it("decodes the hex audio and reports extra_info.audio_length", async () => {
    const hex = Buffer.from("fake-mp3-bytes").toString("hex");
    const fetchFn = vi.fn().mockResolvedValue(ttsResponse(hex, 2340));
    const r = await minimaxTts(CFG, "你好", "male-qn-qingse", { fetchFn });
    expect(r.audio.toString()).toBe("fake-mp3-bytes");
    expect(r.durationMs).toBe(2340);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.minimax.cn/v1/t2a_v2");
    const body = JSON.parse(String(init.body));
    expect(body.voice_setting.voice_id).toBe("male-qn-qingse");
    expect(body.audio_setting.format).toBe("mp3");
    expect(init.headers.Authorization).toBe("Bearer k");
  });

  it("surfaces base_resp errors as retryable/non-retryable MinimaxError", async () => {
    const mk = (code: number) => new Response(JSON.stringify({
      base_resp: { status_code: code, status_msg: "boom" },
    }), { status: 200 });
    await expect(minimaxTts(CFG, "x", "v", { fetchFn: vi.fn().mockResolvedValue(mk(1004)) }))
      .rejects.toMatchObject({ statusCode: 1004, retryable: false });
    await expect(minimaxTts(CFG, "x", "v", { fetchFn: vi.fn().mockResolvedValue(mk(1002)) }))
      .rejects.toMatchObject({ statusCode: 1002, retryable: true });
    await expect(minimaxTts(CFG, "x", "v", { fetchFn: vi.fn().mockResolvedValue(mk(1008)) }))
      .rejects.toMatchObject({ statusCode: 1008, retryable: false });
  });

  it("rejects an empty/invalid audio payload", async () => {
    await expect(minimaxTts(CFG, "x", "v", { fetchFn: vi.fn().mockResolvedValue(ttsResponse("", 100)) }))
      .rejects.toBeInstanceOf(MinimaxError);
  });

  it("test connection reports success and failure with friendly hints", async () => {
    const hex = Buffer.from("x").toString("hex");
    const ok = await minimaxTestConnection(CFG, "male-qn-qingse", vi.fn().mockResolvedValue(ttsResponse(hex, 500)) as unknown as typeof fetch);
    expect(ok.ok).toBe(true);
    const bad = await minimaxTestConnection(CFG, "v", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      base_resp: { status_code: 1004, status_msg: "invalid" },
    }), { status: 200 })) as unknown as typeof fetch);
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain("API Key");
    expect(friendlyError(new MinimaxError(1008, "x"))).toContain("余额");
  });

  it("clone walks the two-step protocol (multipart upload -> voice_clone)", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push([String(url), init]);
      if (String(url).endsWith("/v1/files/upload")) {
        return new Response(JSON.stringify({ file: { file_id: "f123" }, base_resp: { status_code: 0 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ base_resp: { status_code: 0 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await minimaxCloneVoice(CFG, "C:/s.wav", fetchFn);
    expect(r.voiceId).toMatch(/^easerec[a-z0-9]{10}$/);
    expect(newCloneVoiceId()).toMatch(/^[a-z][a-z0-9]{7,}$/);
    expect(calls[0][0]).toContain("/v1/files/upload");
    const up = calls[0][1]!;
    const ct = (up.headers as Record<string, string>)["Content-Type"];
    expect(ct).toMatch(/multipart\/form-data; boundary=/);
    const body = up.body as unknown as Buffer;
    expect(body.toString()).toContain('name="purpose"');
    expect(body.toString()).toContain("voice_clone");
    expect(calls[1][0]).toContain("/v1/voice_clone");
    expect(JSON.parse(String(calls[1][1]!.body))).toMatchObject({ file_id: "f123" });
  });
});
