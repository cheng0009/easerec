/**
 * E2E full-feature verification against a REAL desktop capture.
 *
 * Mirrors electron/main.ts#runExport (the exact path the UI triggers):
 *   - input: gdigrab real-screen capture (20s, 640x360, mpeg4+aac)
 *   - session sidecars (edits.json / camtrack / mouse) written to a temp dir
 *   - runExportPipeline with every export feature enabled at once:
 *       cut (pause/privacy), speedup (F4 whoosh), privacy mask mosaic,
 *       brand outro, vertical 9:16, loudnorm, subtitles (whisper)
 *   - ffprobe the outputs for duration / resolution / stream sanity
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExportPipeline, probeMedia, type RunContext } from "./run";
import type { ExportSettings } from "./plan";
import { emptyEdl, appendEdit, type CutEdit, type SpeedupEdit, type MaskEdit } from "../../src/recording/edl";
import { parseMouseTrack } from "../../src/recording/focusZoom";

const FFMPEG = path.resolve(__dirname, "..", "..", "src-tauri", "ffmpeg.exe");
const FFPROBE = path.resolve(__dirname, "..", "..", "src-tauri", "ffprobe.exe");
const CAPTURE = path.join(process.env.TEMP ?? tmpdir(), "opencode", "e2e", "real_capture.mp4");
const hasReqs = existsSync(CAPTURE) && existsSync(FFMPEG) && existsSync(FFPROBE);

function probe(file: string) { return probeMedia(FFMPEG, file); }

function fullSettings(): ExportSettings {
  return {
    fps: 15,
    zoomEnabled: true,
    zoomLevel: 1.5,
    brandOutro: true, // default ON in the real app
    brandFontPath: path.join(process.env.WINDIR || "C:\\Windows", "Fonts", "msyh.ttc"),
    brandLogoPath: "",
    brandTitle: "简录 EaseRec",
    brandSlogan: "简录，让知识输出回归纯粹。",
    loudnorm: true,
    subtitles: true,
    subtitleStyle: {
      fontFamily: "Microsoft YaHei", fontSize: 28, color: "#FFFFFF",
      outlineColor: "#000000", outlineWidth: 2, position: "bottom", marginV: 40,
    },
    llmEnabled: false,
    glossary: "",
    introEnabled: false,
    introPath: "",
    introDurationS: 3,
    outroEnabled: false,
    outroPath: "",
    outroDurationS: 3,
    vertical: true,
    sourceWidth: 640,
    sourceHeight: 360,
    verticalWidth: 270,
    verticalHeight: 480,
  };
}

function ctx(projectDir: string): RunContext {
  return {
    ffmpegPath: FFMPEG,
    projectDir,
    whisperModelPath: "",
    asrLanguage: "zh",
    onProgress: () => {},
    onLog: (line: string) => console.log(`[E2E:log] ${line}`),
  };
}

let dir: string;
let outputPath: string;
export const KEEP_DIR = path.join(tmpdir(), "opencode", "e2e");

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dc-e2e-real-"));
  outputPath = path.join(dir, "e2e_full.mp4");
});

afterAll(() => {
  // Persist the exported samples next to the capture for manual inspection.
  try {
    mkdirSync(KEEP_DIR, { recursive: true });
    for (const f of ["e2e_full.mp4", "e2e_full_vertical.mp4", "e2e_full.mp4.transcript.json"]) {
      const src = path.join(dir, f);
      if (existsSync(src)) copyFileSync(src, path.join(KEEP_DIR, f));
    }
  } catch { /* best-effort */ }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(hasReqs)("E2E: real desktop capture -> full-feature export", () => {
  it("exports with cut+speedup+mask+brand+vertical+loudnorm+subtitles", async () => {
    console.log(`\n[E2E] input: ${CAPTURE} (${existsSync(CAPTURE) ? "ok" : "MISSING"})`);
    const src = await probe(CAPTURE);
    console.log(`[E2E] source probe: v=${src.width}x${src.height} dur=${src.durationS.toFixed(2)}s audio=${src.hasAudio}`);

    // 1) EDL — realistic marks a presenter would leave on a 20s recording.
    const edl = emptyEdl();
    edl.durationMs = Math.round(src.durationS * 1000);
    edl.finalized = true;
    const edits: (CutEdit | SpeedupEdit | MaskEdit)[] = [
      // pause/rewind cut: [4s, 6.5s) removed (F10 pause)
      { type: "cut", startMs: 4000, endMs: 6500, reason: "pause" },
      // fast-forward: [10s, 15s) compressed to ~4s with whoosh (F4).
      // NOTE: targetSecs must beat clamp(srcLen/1000, a, b) — 5s source
      // needs b < 5, otherwise the speedup collapses to no-op.
      { type: "speedup", startMs: 10000, endMs: 15000, targetSecs: [2, 4], audio: "whoosh" as const },
      // privacy mask: box at top-left over [15.5s, 18s] (F6) + mute audio there
      { type: "mask", startMs: 15500, endMs: 18000, region: { x: 0.05, y: 0.05, w: 0.35, h: 0.3 }, style: "black" as const, muteAudio: true, startSource: "manual", pending: false, drawnAtMs: 15500, refRegionHash: "", refPixels: "" },
    ];
    for (const e of edits) appendEdit(edl, e);

    // 2) Session sidecars (cam track + mouse track for vertical/focus).
    const camTrack = path.join(dir, "cam.jsonl");
    const mouseTrack = path.join(dir, "mouse.jsonl");
    writeFileSync(camTrack, Array.from({ length: 20 }, (_, i) => JSON.stringify({ tMs: i * 1000, x: 0.5, y: 0.5, w: 1, h: 1 })).join("\n") + "\n", "utf8");
    writeFileSync(mouseTrack, Array.from({ length: 60 }, (_, i) => JSON.stringify({ tMs: i * 300, x: 0.5 + 0.3 * Math.sin(i / 6), y: 0.5 })).join("\n") + "\n", "utf8");

    // 3) Set the model dir for whisper (bundled ggml-base.bin). projectDir
    // must be the repo ROOT so resolveWhisper finds src-tauri/whisper/.
    const projectDir = path.resolve(__dirname, "..", "..");

    const res = await runExportPipeline({
      inputPath: CAPTURE,
      outputPath,
      outDir: dir,
      edl,
      durationMs: edl.durationMs!,
      settings: fullSettings(),
      camTrackPath: camTrack,
      mouseTrack: parseMouseTrack(readFileSync(mouseTrack, "utf8")),
      recordRegion: null,
      llmConfig: { enabled: false, baseUrl: "", apiKey: "", model: "" },
      ctx: ctx(projectDir),
    });
    console.log(`\n[E2E] result: ${res}`);

    expect(res).toContain("Saved to:");
    expect(existsSync(outputPath)).toBe(true);

    const out = await probe(outputPath);
    console.log(`[E2E] output probe: v=${out.width}x${out.height} dur=${out.durationS.toFixed(2)}s audio=${out.hasAudio}`);
    expect(out.width).toBeGreaterThan(0);
    expect(out.hasAudio).toBe(true);
    // Timeline math: 20s source - 2.5s cut = 17.5s; the 5s speedup segment
    // compresses to clamp(5,2,4)=4s -> 16.5s main content; +~5.7s brand
    // outro (name/slogan card) -> ~22s total. Allow wide slack for the
    // loudnorm pass to land anywhere around there.
    expect(out.durationS).toBeGreaterThan(15);
    expect(out.durationS).toBeLessThan(26);

    // Vertical 9:16 derivative exists alongside. (name = <main>_vertical.mp4)
    const vOut = outputPath.replace(/\.mp4$/i, "") + "_vertical.mp4";
    console.log(`[E2E] vertical exists: ${existsSync(vOut)}`);
    expect(existsSync(vOut)).toBe(true);
    if (existsSync(vOut)) {
      const v = await probe(vOut);
      console.log(`[E2E] vertical probe: v=${v.width}x${v.height} dur=${v.durationS.toFixed(2)}s`);
      expect(v.height).toBeGreaterThan(v.width); // 9:16 portrait
    }

    // Subtitles transcript written next to output only when ASR ran.
    const trPath = path.join(dir, path.basename(outputPath) + ".transcript.json");
    console.log(`[E2E] transcript exists: ${existsSync(trPath)}`);
  }, 600000);
});