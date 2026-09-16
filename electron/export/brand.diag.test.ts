import { mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runExportPipeline } from "./run";
import { emptyEdl } from "../../src/recording/edl";
import type { ExportSettings } from "./plan";

const FFMPEG = path.resolve(__dirname, "..", "..", "src-tauri", "ffmpeg.exe");
const INPUT = "C:/Users/qiang/AppData/Local/Temp/opencode/e2e/real_capture.mp4";
const hasFfmpeg = existsSync(FFMPEG);
const hasInput = existsSync(INPUT);

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
    sourceWidth: 640,
    sourceHeight: 360,
    verticalWidth: 270,
    verticalHeight: 480,
  };
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

describe.runIf(hasFfmpeg && hasInput)("brand outro diagnose", () => {
  it("compares no-brand vs brand output", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dc-brand-diag-"));
    try {
      const outA = path.join(dir, "nobrand.mp4");
      const resA = await runExportPipeline({
        inputPath: INPUT, outputPath: outA, outDir: dir,
        edl: emptyEdl(), durationMs: 20000,
        settings: base(),
        llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
        ctx: { ffmpegPath: FFMPEG, projectDir: path.resolve(__dirname, "..", ".."), whisperModelPath: "", asrLanguage: "zh", onProgress: () => {} },
      });
      const durA = existsSync(outA) ? await probeDuration(outA) : 0;
      console.log("DIAG no-brand:", resA.slice(0, 30), "dur=", durA);

      const outB = path.join(dir, "brand.mp4");
      const resB = await runExportPipeline({
        inputPath: INPUT, outputPath: outB, outDir: dir,
        edl: emptyEdl(), durationMs: 20000,
        settings: { ...base(), brandOutro: true },
        llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
        ctx: { ffmpegPath: FFMPEG, projectDir: path.resolve(__dirname, "..", ".."), whisperModelPath: "", asrLanguage: "zh", onProgress: () => {} },
      });
      const durB = existsSync(outB) ? await probeDuration(outB) : 0;
      console.log("DIAG brand:  ", resB.slice(0, 30), "dur=", durB);

      const tailPng = path.join(dir, "tail.png");
      mkdirSync(dir, { recursive: true });
      if (existsSync(outB)) {
        try {
          execFileSync(FFMPEG, ["-sseof", "-0.3", "-i", outB, "-frames:v", "1", "-y", tailPng], { stdio: "ignore" });
          console.log("DIAG brand tail frame:", existsSync(tailPng) ? tailPng : "FAILED");
        } catch {
          console.log("DIAG brand tail frame: FAILED");
        }
      }

      expect(durB).toBeGreaterThan(durA + 1); // brand adds ~2.8s
      expect(durB).toBeGreaterThan(20);
    } finally {
      // rmSync(dir, { recursive: true, force: true });
      console.log("DIAG kept dir:", dir);
    }
  }, 240000);
});