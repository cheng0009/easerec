/**
 * INTEGRATION tests — exercise the full export pipeline against the real
 * bundled ffmpeg (src-tauri/ffmpeg.exe). Skipped when ffmpeg is unavailable
 * (e.g. fresh clone without scripts/download-ffmpeg.ps1).
 *
 * These tests are the safety net for the ffmpeg arg builders: a wrong flag
 * fails loudly here, in CI-grade time, instead of silently corrupting an
 * hour-long user recording.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExportPipeline, type RunContext } from "./run";
import type { ExportSettings } from "./plan";
import { appendEdit, emptyEdl, type CutEdit, type EdlFile, type SpeedupEdit } from "../../src/recording/edl";
import { parseMouseTrack, replayCamera, downsampleCamera, buildZoompanGraph } from "../../src/recording/focusZoom";

const FFMPEG = path.resolve(__dirname, "..", "..", "src-tauri", "ffmpeg.exe");
const hasFfmpeg = process.platform === "win32" && existsSync(FFMPEG);

const cut = (startMs: number, endMs: number): CutEdit => ({ type: "cut", startMs, endMs, reason: "rewind" });
const speedup = (startMs: number, endMs: number): SpeedupEdit =>
  ({ type: "speedup", startMs, endMs, targetSecs: [3, 5], audio: "whoosh" });

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dc-export-"));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function generateInput(file: string, seconds: number): void {
  execFileSync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=15:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac",
    file,
  ], { stdio: "ignore", timeout: 60000 });
}

function probeDurationSecs(file: string): Promise<number> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(FFMPEG, ["-i", file], { windowsHide: true });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("close", () => {
      const m = out.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/);
      resolve(m ? (+m[1] * 3600) + (+m[2] * 60) + +m[3] + Number(`0.${m[4]}`) : 0);
    });
    child.on("error", () => resolve(0));
  });
}

function baseSettings(): ExportSettings {
  return {
    fps: 15,
    zoomEnabled: false,
    zoomLevel: 1.5,
    brandOutro: false,
    brandFontPath: "C:/Windows/Fonts/msyh.ttc",
    brandLogoPath: "",
    brandTitle: "简录 EaseRec",
    brandSlogan: "简录，让知识输出回归纯粹。",
    trimSilence: false,
    silenceThresholdS: 0,
    loudnorm: false,
    subtitles: false,
    subtitleStyle: {
      fontFamily: "Arial", fontSize: 20, color: "#FFFFFF", outlineColor: "#000000",
      outlineWidth: 2, position: "bottom", marginV: 20,
    },
    llmEnabled: false,
    glossary: "",
    introEnabled: false,
    introPath: "",
    introDurationS: 3,
    outroEnabled: false,
    outroPath: "",
    outroDurationS: 3,
    vertical: false,
    sourceWidth: 320,
    sourceHeight: 240,
    verticalWidth: 270,
    verticalHeight: 480,
  };
}

function ctx(): RunContext {
  return {
    ffmpegPath: FFMPEG,
    projectDir: path.resolve(__dirname, "..", ".."),
    whisperModelPath: "",
    asrLanguage: "zh",
    onProgress: () => {},
  };
}

describe.runIf(hasFfmpeg)("export pipeline (real ffmpeg)", () => {
  it("legacy transcode with no EDL produces a valid mp4", async () => {
    const input = path.join(dir, "plain.mp4");
    const output = path.join(dir, "plain_out.mp4");
    generateInput(input, 5);
    const res = await runExportPipeline({
      inputPath: input, outputPath: output, outDir: dir,
      edl: emptyEdl(), durationMs: 5000, settings: baseSettings(),
      llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
      ctx: ctx(),
    });
    expect(res).toContain("Saved to:");
    expect(existsSync(output)).toBe(true);
    expect(await probeDurationSecs(output)).toBeCloseTo(5, 0);
  }, 120000);

  it("applies rewind cut + fast-forward compression end-to-end", async () => {
    // 20s source: cut 2-5s (3s removed), speedup 8-20s (12s -> 5s).
    // Expected output = 2 + 3 + 5 = 10s (+- keyframe rounding).
    const input = path.join(dir, "marks.mp4");
    const output = path.join(dir, "marks_out.mp4");
    generateInput(input, 20);
    let edl = appendEdit(emptyEdl(), cut(2000, 5000));
    edl = appendEdit(edl, speedup(8000, 20000));
    const res = await runExportPipeline({
      inputPath: input, outputPath: output, outDir: dir,
      edl, durationMs: 20000, settings: baseSettings(),
      llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
      ctx: ctx(),
    });
    expect(res).toContain("Saved to:");
    expect(res).toContain("剪除 1 段");
    expect(res).toContain("快进 1 段");
    expect(existsSync(output)).toBe(true);
    const dur = await probeDurationSecs(output);
    expect(dur).toBeGreaterThan(8.5);
    expect(dur).toBeLessThan(12);
  }, 180000);

  it("silence trimming shortens a recording with a silent gap", async () => {
    // 3s tone + 3s silence + 3s tone -> trimmed to ~6s.
    const input = path.join(dir, "silence.mp4");
    const output = path.join(dir, "silence_out.mp4");
    execFileSync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]",
      "-map", "[a]",
      "-c:a", "aac",
      input,
    ], { stdio: "ignore", timeout: 60000 });
    const settings = { ...baseSettings(), trimSilence: true, silenceThresholdS: 1.5 };
    const res = await runExportPipeline({
      inputPath: input, outputPath: output, outDir: dir,
      edl: emptyEdl(), durationMs: 9000, settings,
      llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
      ctx: ctx(),
    });
    expect(res).toContain("Saved to:");
    const dur = await probeDurationSecs(output);
    expect(dur).toBeGreaterThan(4);
    expect(dur).toBeLessThan(7.5);
  }, 120000);

  it("produces a vertical 9:16 derivative from the camera track", async () => {
    const input = path.join(dir, "vert.mp4");
    const output = path.join(dir, "vert_out.mp4");
    const vOut = path.join(dir, "vert_out_vertical.mp4");
    generateInput(input, 5);
    const camTrackPath = path.join(dir, "vert.mp4.camtrack.jsonl");
    writeFileSync(camTrackPath, [
      JSON.stringify({ tMs: 0, x: 0.0, y: 0, w: 0.5, h: 1 }),
      JSON.stringify({ tMs: 2500, x: 0.5, y: 0, w: 0.5, h: 1 }),
      JSON.stringify({ tMs: 4900, x: 0.2, y: 0, w: 0.3, h: 1 }),
    ].join("\n") + "\n");
    const settings = { ...baseSettings(), vertical: true };
    const res = await runExportPipeline({
      inputPath: input, outputPath: output, outDir: dir,
      edl: emptyEdl(), durationMs: 5000, settings, camTrackPath,
      llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
      ctx: ctx(),
    });
    expect(res).toContain("Saved to:");
    expect(existsSync(vOut)).toBe(true);
    const dur = await probeDurationSecs(vOut);
    expect(dur).toBeCloseTo(5, 0);
  }, 120000);

  it("empty ASR output does not break the pipeline (burn stage copies through)", async () => {
    // subtitles=true but whisper missing -> ASR writes empty cues, burn is a
    // stream copy and the pipeline still completes.
    const input = path.join(dir, "asr.mp4");
    const output = path.join(dir, "asr_out.mp4");
    generateInput(input, 4);
    const settings = { ...baseSettings(), subtitles: true, loudnorm: true };
    const res = await runExportPipeline({
      inputPath: input, outputPath: output, outDir: dir,
      edl: emptyEdl(), durationMs: 4000, settings,
      llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
      ctx: ctx(),
    });
    expect(res).toContain("Saved to:");
    expect(existsSync(output)).toBe(true);
  }, 120000);

  it("F6-before windows get covered: canonical backtrace + occurrence scan close the leak", async () => {
    // Scenario that used to leak: a privacy banner sat at the screen EARLIER at
    // another spot (t=2-4s top-left), then at the boxed position (t=4-6s center).
    // The user pressed F6 at 4.5s so the mask's grace start sat INSIDE the final
    // appearance — everything before it (including the earlier 2-4s spot) leaked.
    // The export must (a) run its own backtrace with a scan-pipeline reference
    // and move the mask start to the first center appearance (4.0s), and
    // (b) find the top-left occurrence run and mosaic it.
    const input = path.join(dir, "leak.mp4");
    const output = path.join(dir, "leak_out.mp4");
    const seg = (dur: string, box: string | null, p: string): string[] => {
      const base = ["-y", "-f", "lavfi", "-t", dur, "-r", "15", "-i", "color=c=0x1e1e1e:s=320x240", "-pix_fmt", "yuv420p", "-an"];
      const filter = box ? ["-vf", `drawbox=${box}`] : [];
      execFileSync(FFMPEG, [...base, ...filter, p], { stdio: "ignore", timeout: 60000 });
      return [p];
    };
    const seg0 = path.join(dir, "leak0.mp4");
    const seg1 = path.join(dir, "leak1.mp4");
    const seg2 = path.join(dir, "leak2.mp4");
    seg("2", null, seg0);
    seg("2", "x=20:y=20:w=40:h=16:color=0xcdcdcd:t=fill", seg1); // 2-4s, top-left
    seg("2", "x=140:y=120:w=40:h=16:color=0xcdcdcd:t=fill", seg2); // 4-6s, center
    execFileSync(FFMPEG, [
      "-y", "-i", seg0, "-i", seg1, "-i", seg2,
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]",
      "-map", "[out]", "-r", "15", "-pix_fmt", "yuv420p", "-an", input,
    ], { stdio: "ignore", timeout: 60000 });

    const region = { x: 0.4375, y: 0.5, w: 0.125, h: 0.0667 }; // center box 140,120 40x16 / 320x240
    const edl: EdlFile = {
      ...emptyEdl(),
      edits: [{
        type: "mask",
        startMs: 4300, endMs: 6000, region,
        style: "black", muteAudio: false,
        startSource: "grace", pending: false,
        drawnAtMs: 4500,
        refRegionHash: "0123456789abcdef",
        refPixels: "0".repeat(256),
      }],
    };
    const log: string[] = [];
    const res = await runExportPipeline({
      inputPath: input, outputPath: output, outDir: dir,
      edl, durationMs: 6000, settings: baseSettings(),
      llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
      ctx: { ...ctx(), onLog: (l) => log.push(l) },
    });
    expect(res).toContain("Saved to:");
    expect(existsSync(output)).toBe(true);
    // The export-time backtrace (canonical reference) extended the mask start from
    // the grace 4.3s back to the FIRST appearance anywhere — the top-left 2.0s.
    expect(log.some((l) => l.includes("backtrace (export) mask #0 start 4300ms -> 2000ms")), JSON.stringify(log, null, 2)).toBe(true);
    // The occurrence scan found the earlier top-left appearance as a run too.
    expect(log.some((l) => l.includes("[track] occurrence scan") && l.includes(", 2 occurrences"))).toBe(true);
    const dur = await probeDurationSecs(output);
    expect(dur).toBeGreaterThan(5.6);
    expect(dur).toBeLessThan(6.5);
  }, 180000);
});

describe.runIf(hasFfmpeg)("focus pass (real ffmpeg zoompan)", () => {
  it("renders the follow-focus from a mouse track end-to-end", async () => {
    const input = path.join(dir, "focus.mp4");
    const output = path.join(dir, "focus_out.mp4");
    generateInput(input, 12);

    // Trajectory: center idle 2s -> sweep to (0.8, 0.3) 3s -> dwell 3s -> back 3s.
    const track = parseMouseTrack((() => {
      const rows: string[] = [];
      let t = 0;
      const push = (x: number, y: number) => rows.push(JSON.stringify({ tMs: t, x, y }));
      for (; t <= 2000; t += 40) push(0.5, 0.5);
      for (; t <= 5000; t += 40) push(0.5 + 0.3 * ((t - 2000) / 3000), 0.5 - 0.2 * ((t - 2000) / 3000));
      for (; t <= 8000; t += 40) push(0.8, 0.3);
      for (; t <= 11000; t += 40) push(0.8 - 0.3 * ((t - 8000) / 3000), 0.3 + 0.2 * ((t - 8000) / 3000));
      return rows.join("\n") + "\n";
    })());

    const settings = { ...baseSettings(), zoomEnabled: true };
    const res = await runExportPipeline({
      inputPath: input, outputPath: output, outDir: dir,
      edl: emptyEdl(), durationMs: 12000, settings,
      mouseTrack: track,
      llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
      ctx: ctx(),
    });
    expect(res).toContain("Saved to:");
    expect(existsSync(output)).toBe(true);
    const dur = await probeDurationSecs(output);
    expect(dur).toBeGreaterThan(10.5);
    expect(dur).toBeLessThan(13.5);

    // The zoompan graph itself stays script-sized (not frame-sized).
    const cam = replayCamera(track, { sourceWidth: 320, sourceHeight: 240, zoomLevel: 1.5 });
    const keys = downsampleCamera(cam);
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.length).toBeLessThan(track.length / 4);
    const graph = buildZoompanGraph(keys, { fps: 15, sourceWidth: 320, sourceHeight: 240, outputWidth: 320, outputHeight: 240 });
    expect(graph).toContain("zoompan=z='");
  }, 180000);

  it("focus + EDL marks compose (cut after focus)", async () => {
    const input = path.join(dir, "focus2.mp4");
    const output = path.join(dir, "focus2_out.mp4");
    generateInput(input, 10);
    const track = parseMouseTrack(
      Array.from({ length: 100 }, (_, i) => JSON.stringify({ tMs: i * 100, x: 0.5, y: 0.5 })).join("\n") + "\n",
    );
    let edl = appendEdit(emptyEdl(), cut(2000, 5000));
    edl = appendEdit(edl, speedup(7000, 10000));
    const settings = { ...baseSettings(), zoomEnabled: true };
    const res = await runExportPipeline({
      inputPath: input, outputPath: output, outDir: dir,
      edl, durationMs: 10000, settings,
      mouseTrack: track,
      llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
      ctx: ctx(),
    });
    expect(res).toContain("Saved to:");
    expect(res).toContain("剪除 1 段");
    expect(existsSync(output)).toBe(true);
  }, 180000);
});

describe.runIf(hasFfmpeg)("brand outro (real ffmpeg)", () => {
  it("generates the brand card and appends it to the export", async () => {
    const input = path.join(dir, "brand_src.mp4");
    const output = path.join(dir, "brand_out_final.mp4");
    generateInput(input, 5);
    const settings = {
      ...baseSettings(),
      brandOutro: true,
      brandFontPath: path.join(process.env.WINDIR || "C:\Windows", "Fonts", "msyh.ttc"),
      brandTitle: "简录 EaseRec",
      brandSlogan: "简录，让知识输出回归纯粹。",
    };
    const res = await runExportPipeline({
      inputPath: input, outputPath: output, outDir: dir,
      edl: emptyEdl(), durationMs: 5000, settings,
      llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
      ctx: ctx(),
    });
    expect(res).toContain("Saved to:");
    expect(existsSync(output)).toBe(true);
    // 5s main + 2.8s brand card.
    const dur = await probeDurationSecs(output);
    expect(dur).toBeGreaterThan(7.4);
    expect(dur).toBeLessThan(8.2);
  }, 180000);

  it("generates the brand card with the bundled logo overlaid", async () => {
    const input = path.join(dir, "brand_logo_src.mp4");
    const output = path.join(dir, "brand_logo_out_final.mp4");
    generateInput(input, 5);
    const logo = path.join(__dirname, "../../src-tauri/brand/easerec-logo.png");
    const settings = {
      ...baseSettings(),
      brandOutro: true,
      brandFontPath: path.join(process.env.WINDIR || "C:\Windows", "Fonts", "msyh.ttc"),
      brandLogoPath: logo,
      brandTitle: "简录 EaseRec",
      brandSlogan: "简录，让知识输出回归纯粹。",
    };
    const res = await runExportPipeline({
      inputPath: input, outputPath: output, outDir: dir,
      edl: emptyEdl(), durationMs: 5000, settings,
      llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
      ctx: ctx(),
    });
    expect(res).toContain("Saved to:");
    expect(existsSync(output)).toBe(true);
    const dur = await probeDurationSecs(output);
    expect(dur).toBeGreaterThan(7.4);
    expect(dur).toBeLessThan(8.2);
  }, 180000);
});
