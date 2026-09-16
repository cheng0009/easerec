import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runExportPipeline } from "./run";
import type { EdlFile } from "../../src/recording/edl";

const FFMPEG = path.resolve(__dirname, "..", "..", "src-tauri", "ffmpeg.exe");
const USER_FILE = "C:/Users/qiang/Desktop/DirectorCam_Recording.mp4";
const hasFfmpeg = existsSync(FFMPEG);
const hasUserFile = existsSync(USER_FILE);

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

describe.runIf(hasFfmpeg && hasUserFile)("re-export the user's real file", () => {
  it("brand outro MUST append ~+2.8s to whatever recording is pinned", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dc-userfile-"));
    try {
      // The pinned Desktop file changes as the user re-exports — probe the
      // REAL duration instead of assuming the historical 81.46s.
      const srcDur = await probeDuration(USER_FILE);
      if (srcDur <= 0) { console.log("SKIP: cannot probe source duration"); return; }
      const out = path.join(dir, "out.mp4");
      const base = {
        fps: 30, zoomEnabled: false, zoomLevel: 1.5,
        brandFontPath: "C:/Windows/Fonts/msyh.ttc",
        brandLogoPath: "",
        brandTitle: "简录 EaseRec", brandSlogan: "简录，让知识输出回归纯粹。",
        loudnorm: false, subtitles: false,
        subtitleStyle: { fontFamily: "Arial", fontSize: 20, color: "#FFFFFF", outlineColor: "#000000", outlineWidth: 2, position: "bottom" as const, marginV: 20 },
        llmEnabled: false, glossary: "",
        introEnabled: false, introPath: "", introDurationS: 3,
        outroEnabled: false, outroPath: "", outroDurationS: 3,
        vertical: false,
        sourceWidth: 3840, sourceHeight: 2160,
        verticalWidth: 270, verticalHeight: 480,
      };
      const res = await runExportPipeline({
        inputPath: USER_FILE, outputPath: out, outDir: dir,
        edl: { version: 1, edits: [], finalized: false, createdAt: "", durationMs: Math.round(srcDur * 1000) } as EdlFile,
        durationMs: Math.round(srcDur * 1000),
        settings: { ...base, brandOutro: true },
        llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
        ctx: { ffmpegPath: FFMPEG, projectDir: path.resolve(__dirname, "..", ".."), whisperModelPath: "", asrLanguage: "zh", onProgress: () => {} },
      });
      console.log("RES:", res.slice(0, 40));
      if (!existsSync(out)) { expect(true).toBe(false); return; }
      const dur = await probeDuration(out);
      // Brand outro is ~2.8s; assert the append, whatever the source length.
      console.log(`FINAL DURATION=${dur}s  (source ${srcDur}s — expect ~${(srcDur + 2.8).toFixed(2)} with brand)`);
      expect(dur).toBeGreaterThan(srcDur + 2.5);
    } finally {
      console.log("KEPT:", dir);
      // rmSync(dir, { recursive: true, force: true });
    }
  }, 600000);
});