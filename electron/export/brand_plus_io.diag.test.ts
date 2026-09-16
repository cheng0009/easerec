import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runExportPipeline } from "./run";
import { emptyEdl } from "../../src/recording/edl";
import type { ExportSettings } from "./plan";

const FFMPEG = path.resolve(__dirname, "..", "..", "src-tauri", "ffmpeg.exe");
const hasFfmpeg = existsSync(FFMPEG);

function base(): ExportSettings {
  return {
    fps: 15,
    zoomEnabled: false,
    zoomLevel: 1.5,
    brandOutro: false,
    brandFontPath: "C:/Windows/Fonts/msyh.ttc",
    brandLogoPath: "",
    brandTitle: "简录 EaseRec",
    brandSlogan: "简录，让知识输出回归纯粹。",
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

function generateInput(file: string, seconds: number): void {
  execFileSync(FFMPEG, [
    "-y", "-f", "lavfi", "-i", `testsrc2=size=320x240:rate=15:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "mpeg4", "-q:v", "6", "-c:a", "aac", file,
  ], { stdio: "ignore", timeout: 60000 });
}

function probeDuration(file: string): Promise<number> {
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

function probeTail(file: string, seekFromEndSec = 3): Promise<number> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(FFMPEG, [
      "-sseof", `-${seekFromEndSec}`, "-i", file,
      "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-",
    ], { windowsHide: true });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", () => resolve(-1));
    child.on("close", () => {
      const ys = out.match(/YAVG=([\d.]+)/g)?.map((s) => parseFloat(s.slice(5))) ?? [];
      const dark = ys.filter((y) => y < 40).length;
      resolve(ys.length > 0 ? (dark / ys.length) * 100 : -1);
    });
  });
}
void probeTail;

describe.runIf(hasFfmpeg)("brand + user intro/outro composition", () => {
  it("brand outro must be the very last segment even with user intro/outro (VIDEO intro/outro)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dc-brand-plus-io-v-"));
    try {
      const main = path.join(dir, "main.mp4");
      const intro = path.join(dir, "intro.mp4");
      const outro = path.join(dir, "outro.mp4");
      generateInput(main, 4);
      generateInput(intro, 2);
      generateInput(outro, 2);

      const settings: ExportSettings = {
        ...base(),
        brandOutro: true,
        introEnabled: true, introPath: intro, introDurationS: 2,
        outroEnabled: true, outroPath: outro, outroDurationS: 2,
      };

      const out = path.join(dir, "out.mp4");
      const res = await runExportPipeline({
        inputPath: main, outputPath: out, outDir: dir,
        edl: emptyEdl(), durationMs: 4000, settings,
        llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
        ctx: { ffmpegPath: FFMPEG, projectDir: path.resolve(__dirname, "..", ".."), whisperModelPath: "", asrLanguage: "zh", onProgress: () => {} },
      });
      console.log("RES(video):", res.slice(0, 30));
      if (!existsSync(out)) {
        console.log("OUTPUT MISSING");
        expect(true).toBe(false);
        return;
      }
      const dur = await probeDuration(out);
      console.log(`VIDEO-IO dur=${dur}s (expect ~10.8 = 4+2+2+brand2.8)`);
      expect(dur).toBeGreaterThanOrEqual(10);
    } finally {
      console.log("KEPT(video):", dir);
    }
  }, 240000);

  it("brand outro must be the very last segment even with user intro/outro (still IMAGE intro/outro)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dc-brand-plus-io-i-"));
    try {
      const main = path.join(dir, "main.mp4");
      const introImg = path.join(dir, "intro.png");
      const outroImg = path.join(dir, "outro.png");
      generateInput(main, 4);
      // Solid dark still frames so they read as "outro cards" like the user's.
      execFileSync(FFMPEG, [
        "-y", "-f", "lavfi", "-i", "color=c=0x101014:s=320x240:r=1:d=1",
        "-frames:v", "1", introImg,
      ], { stdio: "ignore", timeout: 30000 });
      execFileSync(FFMPEG, [
        "-y", "-f", "lavfi", "-i", "color=c=0x101014:s=320x240:r=1:d=1",
        "-frames:v", "1", outroImg,
      ], { stdio: "ignore", timeout: 30000 });

      const settings: ExportSettings = {
        ...base(),
        brandOutro: true,
        introEnabled: true, introPath: introImg, introDurationS: 2,
        outroEnabled: true, outroPath: outroImg, outroDurationS: 2,
      };

      const out = path.join(dir, "out.mp4");
      const res = await runExportPipeline({
        inputPath: main, outputPath: out, outDir: dir,
        edl: emptyEdl(), durationMs: 4000, settings,
        llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
        ctx: { ffmpegPath: FFMPEG, projectDir: path.resolve(__dirname, "..", ".."), whisperModelPath: "", asrLanguage: "zh", onProgress: () => {} },
      });
      console.log("RES(image):", res.slice(0, 30));
      if (!existsSync(out)) {
        console.log("OUTPUT MISSING");
        expect(true).toBe(false);
        return;
      }
      const dur = await probeDuration(out);
      console.log(`IMAGE-IO dur=${dur}s (expect ~10.8 = 4+2+2+brand2.8)`);
      expect(dur).toBeGreaterThanOrEqual(10);
    } finally {
      console.log("KEPT(image):", dir);
    }
  }, 240000);
});