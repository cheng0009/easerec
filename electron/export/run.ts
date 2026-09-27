/**
 * Export runner — executes a planned export stage by stage:
 *   - writes concat list files / sendcmd scripts the planner declared,
 *   - spawns ffmpeg for each stage (streaming stderr into a rolling log),
 *   - runs the ASR+LLM hook when the plan contains an "asr" stage (as a
 *     background lane started long before the video line reaches it),
 *   - emits progress events to the renderer,
 *   - collects a human-readable report ("Saved to: …" + edit statistics),
 *   - logs per-stage wall-clock timings so slow exports are attributable.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { concatArgs, concatListContent, encArgs, ENCODER_CANDIDATES, planExport, secs, setPreferredVideoEnc, verticalArgs, verticalGeometry, type EncoderChoice, type ExportSettings, type StageBase } from "./plan";
import { detectZoomRegions } from "../../src/recording/zoomRegions";
import { generateAss } from "../subtitles/ass";
import { segmentsToCues, type WhisperSegment } from "../subtitles/cues";
import { correctTranscript, type LlmConfig } from "../subtitles/llm";
import { resolveWhisper, runWhisper } from "../subtitles/whisper";
import { buildTimeline, type EdlFile, type MaskEdit } from "../../src/recording/edl";
import type { CameraSample } from "./plan";
import { dHash, hashToHex, refFromFrame, type GrayFrame } from "../../src/lib/perceptualHash";
import { scanPrivacyOccurrences, type OccMaskInput } from "../track";
import { scanBacktrace } from "../backtrace";

export interface RunContext {
  ffmpegPath: string;
  projectDir: string;
  whisperModelPath: string;
  asrLanguage: string;
  onProgress: (label: string, index: number, total: number) => void;
  onLog?: (line: string) => void;
}

export interface RunExportRequest {
  inputPath: string;
  /** Region-recording crop (normalized), persisted in the session. */
  recordRegion?: { x: number; y: number; w: number; h: number } | null;
  outputPath: string;
  outDir: string;
  edl: EdlFile;
  durationMs: number;
  settings: ExportSettings;
  camTrackPath?: string;
  /** Mouse trajectory (follow-focus + vertical reframe source). */
  mouseTrack?: { tMs: number; x: number; y: number }[];
  llmConfig: LlmConfig;
  ctx: RunContext;
}

export function execFfmpeg(ffmpegPath: string, args: string[], onLog?: (line: string) => void, cwd?: string, timeoutMs = 60 * 60 * 1000): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    let tail = "";
    let child;
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, cwd });
    } catch (e) {
      resolve({ ok: false, tail: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      tail += "\n[timeout]";
    }, timeoutMs);
    child.stderr?.on("data", (d: Buffer) => {
      tail = (tail + d.toString()).split("\n").slice(-8).join("\n");
      onLog?.(d.toString());
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, tail: tail + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, tail });
    });
  });
}

/**
 * Extract ONE gray frame (256x144, area-scaled — the same pipeline the
 * occurrence scan uses) at a given timestamp, or null when the seek fails.
 */
function extractGrayFrameAt(ffmpeg: string, file: string, atMs: number): Promise<GrayFrame | null> {
  return new Promise((resolve) => {
    const W = 256;
    const H = 144;
    const want = W * H;
    const child = spawn(ffmpeg, [
      "-ss", String(Math.max(0, atMs) / 1000),
      "-an", "-sn", "-i", file,
      "-frames:v", "1",
      "-vf", `scale=${W}:${H}:flags=area`,
      "-pix_fmt", "gray",
      "-f", "rawvideo",
      "-",
    ], { windowsHide: true });
    const chunks: Buffer[] = [];
    let n = 0;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 15000);
    child.stdout.on("data", (d: Buffer) => { chunks.push(d); n += d.length; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => {
      clearTimeout(timer);
      if (n < want) { resolve(null); return; }
      const buf = Buffer.concat(chunks);
      resolve({ data: new Uint8Array(buf.subarray(0, want)), width: W, height: H });
    });
  });
}

/** Merge two occurrence-run lists into one sorted, gap-tolerant timeline. */
function mergeRuns(a: { t0: number; t1: number; rect: { x: number; y: number; w: number; h: number } }[], b: { t0: number; t1: number; rect: { x: number; y: number; w: number; h: number } }[]): typeof a {
  const all = [...a, ...b].sort((p, q) => p.t0 - q.t0);
  const out: typeof a = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r.t0 - last.t1 <= 600 && rectBitEq(last.rect, r.rect)) {
      last.t1 = Math.max(last.t1, r.t1);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function rectBitEq(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, tol = 0.05): boolean {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return Math.abs(ca.x - cb.x) <= tol && Math.abs(ca.y - cb.y) <= tol;
}

/** Probe a media file for duration (s), audio presence, video pixel size,
 *  video frame rate and the audio codec name. fps/codec parse to 0/null when
 *  ffmpeg's banner doesn't carry them (callers treat that as "unknown"). */
export function probeMedia(ffmpeg: string, file: string): Promise<{ durationS: number; hasAudio: boolean; width: number; height: number; fps: number; audioCodec: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ["-i", file], { windowsHide: true });
    let out = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 15000);
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve({ durationS: 0, hasAudio: false, width: 0, height: 0, fps: 0, audioCodec: null }); });
    child.on("close", () => {
      clearTimeout(timer);
      const m = out.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/);
      const durationS = m ? (+m[1] * 3600) + (+m[2] * 60) + +m[3] + Number(`0.${m[4]}`) : 0;
      const v = out.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      const f = out.match(/Video:.*?(\d+(?:\.\d+)?)\s+fps/);
      const a = out.match(/Audio:\s*([a-z0-9_-]+)/);
      resolve({
        durationS,
        hasAudio: /Audio:/.test(out),
        width: v ? +v[1] : 0,
        height: v ? +v[2] : 0,
        fps: f ? parseFloat(f[1]) : 0,
        audioCodec: a ? a[1] : null,
      });
    });
  });
}

/** Read the camera-track JSONL into samples (best-effort). */
export function readCamTrack(camTrackPath: string): CameraSample[] {
  try {
    const txt = fs.readFileSync(camTrackPath, "utf8");
    const out: CameraSample[] = [];
    for (const line of txt.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      try {
        const o = JSON.parse(l) as CameraSample;
        if (Number.isFinite(o.tMs) && Number.isFinite(o.x) && Number.isFinite(o.w)) out.push(o);
      } catch { /* skip bad line */ }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Full orchestrator. Returns the user-facing result string ("Saved to: path"
 * on success so the existing UI keeps working, an error description otherwise).
 */
let encoderProbed = false;

/** Probe hardware H.264 encoders once per process, best first. Being listed
 *  by "-encoders" proves nothing (a compiled-in nvenc still fails with no
 *  NVIDIA GPU), so each candidate must pass a real 3-frame encode. */
async function detectVideoEncoder(ffmpegPath: string): Promise<void> {
  if (encoderProbed) return;
  encoderProbed = true;
  let pick: EncoderChoice | null = null;
  for (const c of ENCODER_CANDIDATES) {
    const { ok } = await execFfmpeg(ffmpegPath, [
      "-y", "-f", "lavfi", "-i", "color=c=black:s=320x320:r=30",
      "-frames:v", "3", ...c.args(2), "-pix_fmt", "yuv420p", "-f", "null", "-",
    ], undefined, undefined, 8000);
    if (ok) { pick = c; break; }
  }
  setPreferredVideoEnc(pick);
  console.log(pick ? `[export] hardware encoder: ${pick.name}` : "[export] no hardware encoder — using libopenh264 (software)");
}

/** Relay ffmpeg's `time=` into throttled stage progress so a long re-encode
 *  doesn't look frozen. Output time underestimates when cuts removed head
 *  time — fine, it's a liveness signal, not a clock. */
function ffmpegProgressRelay(
  req: RunExportRequest, label: string, index: number, total: number,
): ((line: string) => void) | undefined {
  const duration = req.durationMs;
  if (!duration || duration <= 0) return undefined;
  let lastPct = -1;
  let lastAt = 0;
  return (line: string) => {
    const now = Date.now();
    if (now - lastAt < 800) return;
    const m = line.match(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (!m) return;
    lastAt = now;
    const ms = ((+m[1] * 3600) + (+m[2] * 60) + Number(m[3])) * 1000;
    const pct = Math.max(0, Math.min(99, Math.round((ms / duration) * 100)));
    if (pct > lastPct) {
      lastPct = pct;
      req.ctx.onProgress(`${label} ${pct}%`, index, total);
    }
  };
}

/** Per-stage timing: one log line per finished stage (console + export log)
 *  so a slow export can be attributed to its passes — and improvements
 *  measured — instead of guessed from the total. */
function logStageDone(onLog: ((l: string) => void) | undefined, kind: string, label: string, ms: number): void {
  const line = `[export] ${kind} done in ${(ms / 1000).toFixed(1)}s — ${label}`;
  console.log(line);
  onLog?.(line);
}

/** Drop "-movflags +faststart" from a command: the flag rewrites the finished
 *  file to move moov up front — a second full write pass that is worth it only
 *  for the user-facing deliverables, never for intermediates the pipeline
 *  consumes (or re-encodes away) immediately afterwards. */
function withoutFaststart(args: string[]): string[] {
  const i = args.indexOf("-movflags");
  if (i < 0) return args;
  return [...args.slice(0, i), ...args.slice(i + 2)];
}

/** Args for executing a planned stage: deliverables (main output + vertical
 *  derivative) keep +faststart, intermediates drop it. */
function stageArgsFor(stage: StageBase, outputPath: string): string[] {
  const args = stage.args ?? [];
  return stage.output === outputPath || stage.kind === "vertical" ? args : withoutFaststart(args);
}

export async function runExportPipeline(req: RunExportRequest): Promise<string> {
  const { ctx } = req;
  const tTotal0 = Date.now();
  // Before any stage runs: hardware-vs-software decides minutes vs hours.
  const tEnc0 = Date.now();
  await detectVideoEncoder(ctx.ffmpegPath);
  ctx.onLog?.(`[export] encoder probe done in ${((Date.now() - tEnc0) / 1000).toFixed(1)}s`);
  const workDir = path.join(req.outDir, ".dc-export-work");
  fs.mkdirSync(workDir, { recursive: true });

  // An ABORTED recording leaves a webm without cues/duration header: seeking
  // into it is unreliable (spans render 0 frames). Remux stream-copy first —
  // ffmpeg then writes a proper index and duration.
  let inputPath = req.inputPath;
  if (/\.webm$/i.test(inputPath) && !req.edl.finalized) {
    // h264-in-webm (MediaRecorder codecs=h264) cannot be remuxed back into
    // webm — MP4 accepts the streams and gains a usable index/duration.
    const fixed = path.join(workDir, "input_fixed.mp4");
    const { ok } = await execFfmpeg(ctx.ffmpegPath, ["-y", "-i", inputPath, "-c", "copy", fixed], ctx.onLog);
    if (ok && fs.existsSync(fixed) && fs.statSync(fixed).size > 1024) {
      inputPath = fixed;
    }
  }

  // Region crop maps normalized coords onto the ACTUAL captured pixels —
  // settings.resolution only sizes canvas-mode recordings; a raw capture
  // keeps the display's native size, so probe the real stream dimensions.
  // The same probe feeds the privacy-mosaic burn geometry (masks are recorded
  // in normalized frame coords that need the true pixel size).
  const maskEditsPresent = Array.isArray(req.edl.edits) && req.edl.edits.some((e) => e.type === "mask");
  // Any audio-consuming feature (subtitles / loudnorm / voice enhance / BGM)
  // needs to know whether the recording has an audio stream AT ALL — a
  // no-audio recording must not schedule the WAV-extract + Whisper + burn
  // stages (they would fail at extract, or hallucinate fake subtitles).
  const wantsAudioProcessing = req.settings.subtitles || req.settings.loudnorm || !!req.settings.voiceEnhance || !!req.settings.bgmPath;
  let inputVideoSize: { width: number; height: number } | null = null;
  let hasAudio: boolean | undefined;
  let inputAudioCodec: string | null = null;
  let exportFps = Math.max(1, Math.min(120, Math.round(req.settings.fps || 60)));
  {
    // Always probe (one cheap header read): geometry, audio presence, codec
    // and the source frame rate all come from the same invocation.
    const info = await probeMedia(ctx.ffmpegPath, inputPath);
    if (info.width > 0 && info.height > 0) {
      inputVideoSize = { width: info.width, height: info.height };
    }
    if (wantsAudioProcessing) hasAudio = info.hasAudio;
    inputAudioCodec = info.audioCodec;
    // Export fps never exceeds the source frame rate: a config fps above the
    // source only duplicates frames — pure extra encode/decode work. Never
    // raise it, and skip the clamp when ffmpeg reported no sane fps token.
    if (info.fps >= 1 && Math.round(info.fps) < exportFps) {
      exportFps = Math.max(1, Math.round(info.fps));
      ctx.onLog?.(`[export] fps clamped to ${exportFps} (source frame rate ${info.fps})`);
    }
  }
  const settings: ExportSettings = { ...req.settings, fps: exportFps };

  // ASR fast lane: build the transcription wav from an AUDIO-ONLY replica of
  // the cut timeline (seconds of work, no video decode) and run the silence
  // gate + Whisper + LLM in the BACKGROUND while the video line (occurrence
  // scan, zoom spans, segments, burn) grinds through its encodes. The stage
  // loop awaits the results at the extract/asr stages, so ASR latency no
  // longer adds to the export's wall-clock.
  const wavPath = path.join(workDir, "audio16k.wav");
  const assPath = path.join(workDir, "subs.ass");
  let planRef: ReturnType<typeof planExport> | null = null;
  let asrNote = "";
  let wavReady: Promise<void> | null = null;
  let asrDone: Promise<void> | null = null;
  if (settings.subtitles && hasAudio !== false) {
    let resolveWav: () => void = () => { /* filled below */ };
    wavReady = new Promise<void>((r) => { resolveWav = r; });
    const asrT0 = Date.now();
    asrDone = (async () => {
      await buildAsrWavFast(ctx.ffmpegPath, inputPath, req.edl, req.durationMs, wavPath, ctx.onLog);
      resolveWav();
      // Subtitle geometry needs the plan's output size once it exists (region
      // recordings crop the frame); before that, the settings dims are the
      // best guess — and that window can only produce an EMPTY cue list,
      // where PlayRes is irrelevant anyway.
      const sz = () => {
        const o = planRef?.outputSize;
        return o
          ? { width: o.w, height: o.h }
          : { width: settings.sourceWidth, height: settings.sourceHeight };
      };
      const activeMs = fs.existsSync(wavPath) ? await measureActiveMs(ctx.ffmpegPath, wavPath) : 0;
      const speechMs = activeMs ?? 0;
      if (speechMs < MIN_ACTIVE_SPEECH_MS) {
        asrNote = speechMs > 0
          ? `\n（音频无有效语音，仅 ${speechMs} 毫秒底噪 — 未生成字幕）`
          : "\n（音频为静音，未生成字幕）";
        fs.writeFileSync(assPath, generateAss([], req.settings.subtitleStyle, sz()), "utf8");
        ctx.onLog?.(`[export] asr lane: no usable speech (${speechMs}ms active) — subtitles skipped`);
        return;
      }
      const ok = await runAsrStage(req, workDir, assPath);
      if (!ok) {
        // Subtitles were requested but ASR failed -> continue WITHOUT subs
        // rather than losing the whole export (empty cue list).
        fs.writeFileSync(assPath, generateAss([], req.settings.subtitleStyle, sz()), "utf8");
      }
      ctx.onLog?.(`[export] asr lane finished in ${((Date.now() - asrT0) / 1000).toFixed(1)}s`);
    })();
  }

  // Occurrence scan: with masks in the EDL, rewind the whole recording and find
  // EVERY spot where the masked content reappears (same text elsewhere on the
  // page), so the export burns a mosaic there too — not just inside the drawn
  // box. References are sampled live at box-draw time from FULL-res pixels, but
  // the scan compares against 256x144 area-scale crops — a resampling mismatch
  // that systematically depresses every similarity. So we RESAMPLE the
  // reference frame at the exact draw moment through the SAME scan pipeline and
  // re-derive the fingerprint from it. If the strict pass still finds nothing
  // for a mask (content scale/context drifted), a loose recall pass runs for
  // those masks and its runs are merged in.
  let maskTracks;
  let exportEdl = req.edl;
  if (maskEditsPresent) {
    try {
      const maskEdits = req.edl.edits.filter((e): e is MaskEdit => e.type === "mask");
      const masks: OccMaskInput[] = [];
      // Export-time backtrace: the recording-time backtrace sampled its
      // reference from FULL-RES live pixels and compared at 256x144 — a
      // resampling mismatch that depresses every similarity (measured ~0.75 on
      // genuinely present content, below the strict gate), so it routinely fell
      // back to the grace window and the pre-box presence leaked. Here we
      // re-derive the reference through the SAME scan pipeline (one frame at
      // the draw moment, area-scale) and re-run the ladder on the finalized
      // file: same-pipeline similarities sit ~0.92, so the start moves to the
      // true first appearance and the static burn closes the leak.
      const edits = req.edl.edits.slice();
      let patched = 0;
      // Per-mask export-time backtrace — spawn-per-probe (yields naturally),
      // but with many masks it still takes a while: surface it.
      ctx.onProgress(`回溯 ${maskEdits.length} 个遮挡的起点`, 0, 1);
      for (let mi = 0; mi < maskEdits.length; mi++) {
        const m = maskEdits[mi];
        if (mi % 3 === 0) ctx.onProgress(`回溯遮挡起点 ${mi + 1}/${maskEdits.length}`, 0, 1);
        let ref = { refRegionHash: m.refRegionHash ?? "", refPixels: m.refPixels ?? "" };
        let canonFrame: GrayFrame | null = null;
        if (m.drawnAtMs && m.drawnAtMs > 0) {
          const frame = await extractGrayFrameAt(ctx.ffmpegPath, inputPath, m.drawnAtMs);
          if (frame) {
            ref = refFromFrame(frame, m.region);
            canonFrame = frame;
          }
        }
        masks.push({ region: m.region, ...ref });
        if (canonFrame) {
          try {
            const bt = await scanBacktrace({
              webmPath: inputPath,
              ffmpegPath: ctx.ffmpegPath,
              region: m.region,
              refRegionHash: ref.refRegionHash,
              refPixels: ref.refPixels,
              refFrameHash: hashToHex(dHash(canonFrame, 8)),
              fps: 4,
              dynamicEntranceMs: 30000,
              thresholds: { region: 0.72, frame: 0.62 },
            });
            if (bt.startMs !== null && bt.startMs < (m.startMs ?? 0)) {
              const idx = edits.indexOf(m);
              // Preserve `pending`: an open (never F6-ended) mask must keep its
              // end-of-recording extension through the export.
              edits[idx] = { ...m, startMs: bt.startMs, startSource: bt.method ?? "grace" };
              patched++;
              ctx.onLog?.(`[track] backtrace (export) mask #${maskEdits.indexOf(m)} start ${m.startMs}ms -> ${bt.startMs}ms method ${bt.method}`);
            } else if (bt.startMs !== null) {
              ctx.onLog?.(`[track] backtrace (export) mask #${maskEdits.indexOf(m)} kept ${m.startMs}ms (${bt.method})`);
            } else {
              ctx.onLog?.(`[track] backtrace (export) mask #${maskEdits.indexOf(m)}: no match (grace kept)`);
            }
          } catch (e) {
            console.warn("[track] export-time backtrace failed:", e);
          }
        }
      }
      if (patched) {
        exportEdl = { ...req.edl, edits };
        ctx.onLog?.(`[track] backtrace (export) extended ${patched} mask start(s) to their first appearance`);
      }
      // fps 4 vs the old 10: occurrence runs merge ~1s gaps, so 4 samples/sec
      // lose nothing meaningful while cutting the scan work well over half.
      const scanProgress = (label: string) => {
        let lastPct = -1;
        return (frames: number) => {
          const pct = req.durationMs > 0
            ? Math.min(99, Math.round((frames * 250) / req.durationMs * 100))
            : 0;
          if (pct !== lastPct) { lastPct = pct; ctx.onProgress(`${label} ${pct}%`, 0, 1); }
        };
      };
      const scan = await scanPrivacyOccurrences({
        inputPath,
        ffmpegPath: ctx.ffmpegPath,
        durationMs: req.durationMs,
        masks,
        fps: 4,
        timeoutMs: 600_000,
        onProgress: scanProgress("扫描遮罩出现点"),
      });
      let runs = scan.runs;
      ctx.onLog?.(`[track] occurrence scan: ${scan.framesScanned} frames, ${runs.reduce((n, r) => n + r.length, 0)} occurrences`);
      // Recall pass: masks whose strict pass found nothing get one loose lap
      // (lower dHash gate, NCC off, finer coarse net) so scale/context drift
      // still ends up mosaicked.
      const emptyIdx = runs.map((r, i) => (r.length === 0 ? i : -1)).filter((i) => i >= 0);
      if (emptyIdx.length) {
        ctx.onLog?.(`[track] recall pass for masks ${emptyIdx.join(",")} (strict pass empty)`);
        const recall = await scanPrivacyOccurrences({
          inputPath,
          ffmpegPath: ctx.ffmpegPath,
          durationMs: req.durationMs,
          masks,
          dHashMin: 0.60,
          nccMin: null,
          coarseStride: 24,
          maxHits: 20,
          runGapMs: 600,
          fps: 4,
          timeoutMs: 600_000,
          onProgress: scanProgress("补扫遮罩出现点"),
        });
        runs = runs.map((rl, i) => (emptyIdx.includes(i) ? mergeRuns(rl, recall.runs[i] ?? []) : rl));
        ctx.onLog?.(`[track] recall total: ${runs.reduce((n, r) => n + r.length, 0)} occurrences`);
      }
      maskTracks = runs;
    } catch (e) {
      console.warn("[track] occurrence scan skipped:", e);
      ctx.onLog?.(`[track] occurrence scan skipped: ${String(e)}`);
    }
  }

  const plan = planExport({
    inputPath,
    outputPath: req.outputPath,
    workDir,
    edl: exportEdl,
    durationMs: req.durationMs,
    settings,
    camTrackPath: req.camTrackPath,
    mouseTrack: req.mouseTrack,
    recordRegion: req.recordRegion ?? null,
    inputVideoSize,
    inputAudioCodec,
    maskTracks,
    hasAudio,
  });
  planRef = plan;

  const total = plan.stages.length;
  // Subtitles were requested but the recording has NO audio stream: the plan
  // already dropped the extract/asr/burn stages — tell the user why.
  if (req.settings.subtitles && hasAudio === false) {
    asrNote = "\n（未检测到音轨 — 未生成字幕）";
  }
  if (process.env.DC_DUMP_PLAN) {
    console.error("[plan]", JSON.stringify(plan.stages.map((st) => ({ k: st.kind, l: st.label, out: st.output })), null, 1));
  }
  const assFile = plan.stages.find((s) => s.kind === "asr")?.output ?? null;
  // Zoom spans are mutually independent (same input, separate outputs) and a
  // long timeline spawns dozens of them — running them SEQUENTIALLY wastes
  // wall-clock on per-process seek/decode/session overhead. A small pool
  // (3 stays inside consumer NVENC session limits) cuts that ~3x.
  const ZOOM_POOL = 3;
  let i = 0;

  for (let si = 0; si < plan.stages.length; si++) {
    const stage = plan.stages[si];
    ctx.onProgress(stage.label, i++, total);
    const stageT0 = Date.now();
    // The body runs inside an async IIFE so every branch can `return` its
    // failure and the wrapper below logs the stage's wall-clock exactly once.
    const failure = await (async (): Promise<string | null> => {
    if (stage.kind === "zoomspan") {
      // Gather the contiguous zoomspan run and render it concurrently.
      let sj = si;
      while (sj < plan.stages.length && plan.stages[sj].kind === "zoomspan") sj++;
      const batch = plan.stages.slice(si, sj);
      let done = 0;
      let failure: string | null = null;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < batch.length && !failure) {
          const st = batch[cursor++];
          const { ok, tail } = await execFfmpeg(ctx.ffmpegPath, stageArgsFor(st, req.outputPath), ctx.onLog, st.cwd);
          done++;
          ctx.onProgress(`缩放片段 ${done}/${batch.length}`, Math.min(total - 1, si + done), total);
          if (!ok) failure = `Export failed at: ${st.label}
${tail}`;
        }
      };
      await Promise.all(Array.from({ length: Math.min(ZOOM_POOL, batch.length) }, worker));
      if (failure) return failure;
      i = sj;
      si = sj - 1; // the for-loop's si++ resumes at the first non-zoomspan stage
      return null;
    }

    switch (stage.kind) {
      case "concat": {
        // EDL segment list: uniform params -> demuxer stream copy is exact.
        fs.writeFileSync(stage.listFile!, concatListContent(stage.inputs!), "utf8");
        const args = withoutFaststart(concatArgs(stage.listFile!, stage.output, false, settings.fps));
        const { ok, tail } = await execFfmpeg(ctx.ffmpegPath, args, ctx.onLog);
        if (!ok) return `Export failed at: ${stage.label}\n${tail}`;
        return null;
      }
      case "final-concat": {
        // Preferred path (plan.copyConcat): only the SHORT parts (intro/
        // outro/brand — seconds each) are transcoded, normalized to the main
        // line's own encoder settings, and the film splices via the concat
        // DEMUXER with stream copy — the exact splice the zoom/segment
        // concats already rely on. This avoids re-encoding the entire film
        // just to append a 2.8s brand card. The gate guarantees the main
        // line was encoded by this pipeline (matching params) and its audio
        // is aac (or absent); anything else falls through to the filter
        // concat below, which re-encodes but accepts arbitrary inputs.
        const parts = stage.inputs!;
        const W = plan.outputSize.w;
        const H = plan.outputSize.h;
        const F = Math.max(1, Math.round(settings.fps));
        const partDurations = stage.partDurations ?? [];
        const isImg = (p: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(p);
        if (plan.copyConcat) {
          const finalParts: string[] = [];
          for (let pi = 0; pi < parts.length; pi++) {
            const part = parts[pi];
            if (part === stage.mainPart) { finalParts.push(part); continue; }
            const norm = path.join(workDir, `fpart_${pi}.mp4`);
            const dur = Math.max(0.1, partDurations[pi] ?? 3);
            const vChain = isImg(part)
              ? `scale=${W}:${H},setsar=1,format=yuv420p`
              : `scale=${W}:${H},setsar=1,format=yuv420p,fps=${F}`;
            const inputs: string[] = isImg(part)
              ? ["-loop", "1", "-framerate", String(F), "-t", dur.toFixed(3), "-i", part]
              : ["-i", part];
            let nArgs: string[];
            if (hasAudio === false) {
              // The main line carries no audio track — parts must match that
              // stream layout for the demuxer concat to stay frame-exact.
              nArgs = ["-y", ...inputs, "-vf", vChain, "-map", "0:v:0", "-an",
                ...encArgs(W, H), "-r", String(F), norm];
            } else {
              const info = isImg(part) ? { hasAudio: false, durationS: dur } : await probeMedia(ctx.ffmpegPath, part);
              if (info.hasAudio) {
                nArgs = ["-y", ...inputs, "-vf", vChain, "-map", "0:v:0", "-map", "0:a:0",
                  "-af", "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
                  ...encArgs(W, H), "-r", String(F), norm];
              } else {
                inputs.push("-f", "lavfi", "-t", Math.max(0.1, info.durationS).toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
                nArgs = ["-y", ...inputs,
                  "-filter_complex",
                  `[0:v]${vChain}[v];[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a]`,
                  "-map", "[v]", "-map", "[a]",
                  ...encArgs(W, H), "-r", String(F), norm];
              }
            }
            const { ok, tail } = await execFfmpeg(ctx.ffmpegPath, nArgs, ctx.onLog);
            if (!ok) return `Export failed at: ${stage.label} (normalize ${path.basename(part)})\n${tail}`;
            finalParts.push(norm);
          }
          fs.writeFileSync(stage.listFile!, concatListContent(finalParts), "utf8");
          const { ok, tail } = await execFfmpeg(ctx.ffmpegPath, withoutFaststart(concatArgs(stage.listFile!, stage.output, false, F)), ctx.onLog);
          if (!ok) return `Export failed at: ${stage.label}\n${tail}`;
          ctx.onLog?.("[export] final concat spliced via stream copy (no film re-encode)");
          return null;
        }
        // Fallback: the concat DEMUXER with re-encode inflates duration
        // (~+0.7s/extra part on this ffmpeg build); the concat FILTER is
        // exact, so normalize every input (scale/SAR/pix_fmt/fps + audio
        // format, silent track when missing) and splice in-filter. Sizes come
        // from the PLAN (region recording crops the frame — scaling to the
        // settings size would distort).
        const inputs: string[] = [];
        const chains: string[] = [];
        const labels: string[] = [];
        let idx = 0;
        for (let i2 = 0; i2 < parts.length; i2++) {
          const part = parts[i2];
          const vIdx = idx++;
          // Still-image intro/outro parts: loop the single frame for the
          // configured hold duration (3s default), with a silent track of
          // the same length. Videos are handled through probeMedia below.
          if (isImg(part)) {
            const dur = Math.max(0.1, partDurations[i2] ?? 3);
            inputs.push("-loop", "1", "-t", dur.toFixed(3), "-i", part);
            const aIdx = idx++;
            inputs.push("-f", "lavfi", "-t", dur.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
            chains.push(`[${vIdx}:v]scale=${W}:${H},setsar=1,format=yuv420p,fps=${F},setpts=PTS-STARTPTS[v${vIdx}]`);
            chains.push(`[${aIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${vIdx}]`);
            labels.push(`[v${vIdx}][a${vIdx}]`);
            continue;
          }
          inputs.push("-i", part);
          const info = await probeMedia(ctx.ffmpegPath, part);
          if (info.hasAudio) {
            chains.push(`[${vIdx}:v]scale=${W}:${H},setsar=1,format=yuv420p,fps=${F}[v${vIdx}]`);
            chains.push(`[${vIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${vIdx}]`);
          } else {
            const aIdx = idx++;
            inputs.push("-f", "lavfi", "-t", Math.max(0.1, info.durationS).toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
            chains.push(`[${vIdx}:v]scale=${W}:${H},setsar=1,format=yuv420p,fps=${F}[v${vIdx}]`);
            chains.push(`[${aIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${vIdx}]`);
          }
          labels.push(`[v${vIdx}][a${vIdx}]`);
        }
        const graph = chains.join(";") + ";" + labels.join("") + `concat=n=${parts.length}:v=1:a=1[v][a]`;
        const args = [
          "-y", ...inputs,
          "-filter_complex", graph,
          "-map", "[v]", "-map", "[a]",
          ...encArgs(W, H), "-r", String(F),
          stage.output,
        ];
        const { ok, tail } = await execFfmpeg(ctx.ffmpegPath, withoutFaststart(args), ctx.onLog);
        if (!ok) return `Export failed at: ${stage.label}\n${tail}`;
        return null;
      }
      case "asr": {
        // The fast lane (started before the video stages) built the wav from
        // an audio-only replica and ran the sustained-speech gate + Whisper +
        // LLM in the background; by the time the video line reaches this point
        // the result is usually already on disk. The gate itself FIRMLY fails
        // closed inside the lane: a missing/empty/unreadable wav counts as 0
        // active ms, so no wav state can ever feed Whisper fake silence.
        if (asrDone) {
          await asrDone;
          return null;
        }
        // Defensive fallback (lane not started): fail closed to empty cues so
        // the burn stage stream-copies through instead of dying.
        fs.writeFileSync(stage.output, generateAss([], req.settings.subtitleStyle, {
          width: plan.outputSize.w, height: plan.outputSize.h,
        }), "utf8");
        return null;
      }
      case "burn": {
        // Skip the extra re-encode pass when ASR produced no cues at all, but
        // keep the pipeline chain intact via a fast stream copy.
        const assText = assFile && fs.existsSync(assFile) ? fs.readFileSync(assFile, "utf8") : "";
        if (!assText.includes("Dialogue:")) {
          const burnInput = stage.args![stage.args!.indexOf("-i") + 1];
          fs.copyFileSync(burnInput, stage.output);
          return null;
        }
        const { ok, tail } = await execFfmpeg(ctx.ffmpegPath, stageArgsFor(stage, req.outputPath), ctx.onLog, stage.cwd);
        if (!ok) return `Export failed at: ${stage.label}\n${tail}`;
        return null;
      }
      case "vertical": {
        // Framing follows the zoom regions (where the presenter worked);
        // fall back to the legacy cam track; static centered crop last.
        let samples = readCamTrack(stage.camTrackPath || "");
        if ((req.mouseTrack?.length ?? 0) > 5) {
          const regions = detectZoomRegions(req.mouseTrack!, { depth: req.settings.zoomLevel ?? 1.5 });
          samples = regions.map((r) => {
            const vw = 1 / r.depth;
            const vh = 1 / r.depth;
            return {
              tMs: (r.startMs + r.endMs) / 2,
              x: Math.max(0, Math.min(1 - vw, r.cx - vw / 2)),
              y: Math.max(0, Math.min(1 - vh, r.cy - vh / 2)),
              w: vw,
              h: vh,
            };
          });
        }
        // Cam-track coords live in FULL-capture space; with a region crop the
        // reframe runs on the cropped frame — remap like the mouse track.
        const rr = req.recordRegion;
        if (rr && rr.w > 0.02 && rr.h > 0.02) {
          samples = samples.map((s) => ({
            ...s,
            x: (s.x - rr.x) / rr.w,
            y: (s.y - rr.y) / rr.h,
            w: s.w / rr.w,
            h: s.h / rr.h,
          }));
        }
        const geo = verticalGeometry(
          samples, plan.outputSize.w, plan.outputSize.h,
          stage.verticalWidth, stage.verticalHeight,
        );
        fs.writeFileSync(stage.sendcmdFile!, geo.sendcmd, "utf8");
        const args = verticalArgs(
          req.outputPath, stage.output, geo, stage.sendcmdFile!,
          stage.verticalWidth, stage.verticalHeight, settings.fps,
        );
        // A vertical-derivative failure must not fail the main export.
        const v = await execFfmpeg(ctx.ffmpegPath, args, ffmpegProgressRelay(req, stage.label, i - 1, total), stage.cwd);
        if (!v.ok) console.error(`[export] vertical pass failed:\n${v.tail}`);
        return null;
      }
      default: {
        if (!stage.args) return null;
        // The ASR fast lane already built audio16k.wav (an audio-only replica
        // of the cut timeline, equivalent to what this extract would produce):
        // wait for it rather than re-extracting from the video timeline.
        if (wavReady && stage.kind === "transcode" && path.basename(stage.output) === "audio16k.wav") {
          await wavReady;
          if (fs.existsSync(stage.output)) return null;
        }
        const { ok, tail } = await execFfmpeg(ctx.ffmpegPath, stageArgsFor(stage, req.outputPath), ffmpegProgressRelay(req, stage.label, i - 1, total), stage.cwd);
        if (!ok) return `Export failed at: ${stage.label}\n${tail}`;
        return null;
      }
    }
    })();
    logStageDone(ctx.onLog, stage.kind, stage.label, Date.now() - stageT0);
    if (failure) return failure;
  }
  ctx.onProgress("done", total, total);
  {
    const line = `[export] pipeline finished in ${((Date.now() - tTotal0) / 1000).toFixed(1)}s (${total} stages)`;
    console.log(line);
    ctx.onLog?.(line);
  }

  const r = plan.report;
  const parts: string[] = [];
  if (r.cuts) parts.push(`剪除 ${r.cuts} 段共 ${(r.cutsMs / 1000).toFixed(1)} 秒`);
  if (r.masks) parts.push(`遮挡 ${r.masks} 处`);
  if (r.speedups) parts.push(`快进 ${r.speedups} 段`);
  const suffix = parts.length ? `（${parts.join("，")}）` : "";
  return `Saved to: ${req.outputPath}${suffix}${asrNote}`;
}

/** whisper -> optional LLM correction -> ASS. */
/** Silence gate constants: audio below -35dB sustained for ≥0.4s counts as
 *  silence; < MIN_ACTIVE_SPEECH_MS of non-silent audio is "no real speech". */
const SILENCE_NOISE_DB = -35;
const SILENCE_MIN_S = 0.4;
const MIN_ACTIVE_SPEECH_MS = 800;

/** Total non-silent ("active") time of a wav in ms, via ffmpeg silencedetect.
 *  Returns null only when the measurement itself fails (missing/corrupt wav) —
 *  callers FAIL CLOSED and treat that as silence, so a broken or empty extract
 *  can never flow into Whisper as though it were real speech. */
async function measureActiveMs(ffmpegPath: string, wav: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, [
      "-hide_banner", "-i", wav,
      "-af", `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_S}`,
      "-f", "null", "-",
    ], { windowsHide: true });
    let out = "";
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const dur = out.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/);
      if (!dur) return resolve(null);
      const totalMs = ((+dur[1] * 3600) + (+dur[2] * 60) + +dur[3] + Number(`0.${dur[4]}`)) * 1000;
      // silencedetect prints alternating silence_start / silence_end lines;
      // a trailing silence to EOF has a start but no end — close it at the EOF.
      let silentMs = 0;
      let curStart: number | null = null;
      const re = /silence_(start|end):\s*([\d.]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(out)) !== null) {
        const t = parseFloat(m[2]) * 1000;
        if (m[1] === "start") curStart = t;
        else if (curStart !== null) { silentMs += t - curStart; curStart = null; }
      }
      if (curStart !== null) silentMs += Math.max(0, totalMs - curStart);
      resolve(Math.max(0, Math.round(totalMs - silentMs)));
    });
  });
}

/** Build the ASR wav from an AUDIO-ONLY replica of the cut timeline.
 *  Equivalent to the historic "extract from timeline.mp4" but needs no video
 *  decode: plain 1x segments are seeked straight out of the source audio, F4
 *  speedups get their whoosh/mute replacement audio at output duration, and
 *  the parts concatenate into one 16k mono wav. Finishes in seconds even for
 *  hour-long films, which is what lets transcription start (and usually
 *  finish) while the video line is still encoding. Any failure removes the
 *  partial wav — the callers fail closed on a missing file. */
async function buildAsrWavFast(
  ffmpeg: string,
  input: string,
  edl: EdlFile,
  durationMs: number,
  wavOut: string,
  onLog?: (l: string) => void,
): Promise<void> {
  const rm = (): void => { try { fs.rmSync(wavOut, { force: true }); } catch { /* ignore */ } };
  const needsSegments = edl.edits.some((e) => e.type === "cut" || e.type === "speedup");
  const enc = ["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"];
  if (!needsSegments) {
    const { ok } = await execFfmpeg(ffmpeg, ["-y", "-i", input, "-vn", ...enc, wavOut], onLog);
    if (!ok) rm();
    return;
  }
  const segments = buildTimeline(edl, durationMs);
  const workDir = path.dirname(wavOut);
  const parts: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const part = path.join(workDir, `asrpart_${i}.wav`);
    const outSecs = (seg.outEndMs - seg.outStartMs) / 1000;
    let args: string[];
    if (seg.speed === 1) {
      args = [
        "-y", "-ss", secs(seg.srcStartMs), "-t", secs(seg.srcEndMs - seg.srcStartMs), "-i", input,
        "-vn", ...enc, part,
      ];
    } else {
      // Speedups never carry speech in the film: the audio is the whoosh (or
      // silence) at the COMPRESSED duration — replicate that exactly so the
      // transcript's clock matches the exported timeline.
      const via = seg.via as { audio: "mute" | "whoosh" };
      if (via.audio === "whoosh") {
        const fadeStart = Math.max(0, outSecs - 0.3);
        args = [
          "-y", "-f", "lavfi", "-t", outSecs.toFixed(3), "-i", "anoisesrc=color=pink:r=48000:amplitude=0.35",
          "-af", `lowpass=f=900,afade=t=in:st=0:d=0.3,afade=t=out:st=${fadeStart.toFixed(3)}:d=0.3`,
          ...enc, part,
        ];
      } else {
        args = [
          "-y", "-f", "lavfi", "-t", outSecs.toFixed(3), "-i", "anullsrc=r=48000:cl=mono",
          ...enc, part,
        ];
      }
    }
    const { ok } = await execFfmpeg(ffmpeg, args);
    if (ok && fs.existsSync(part)) parts.push(part);
    else { rm(); return; }
  }
  if (parts.length === 1) {
    try { fs.renameSync(parts[0], wavOut); return; } catch { /* fall through to concat */ }
  }
  const listFile = path.join(workDir, "asr_concat.txt");
  fs.writeFileSync(listFile, concatListContent(parts), "utf8");
  const { ok } = await execFfmpeg(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", wavOut], onLog);
  if (!ok) rm();
}

async function runAsrStage(req: RunExportRequest, workDir: string, assFile: string): Promise<boolean> {
  const wav = path.join(workDir, "audio16k.wav");
  if (!fs.existsSync(wav)) return false;
  const bin = resolveWhisper(req.ctx.projectDir, req.ctx.whisperModelPath);
  if (!bin) {
    console.error("[export] whisper-cli not found — run scripts/download-whisper.ps1");
    return false;
  }
  const res = await runWhisper(bin, wav, workDir, {
    language: req.ctx.asrLanguage || "zh",
    glossary: req.llmConfig.glossary,
  });
  if (!res.ok) {
    console.error("[export] whisper failed:", res.error);
    return false;
  }
  const timed: WhisperSegment[] = res.segments;
  const corrected = await correctTranscript(
    timed.map((s, id) => ({ id, text: s.text })),
    req.llmConfig,
  );
  const merged = timed.map((seg, id) => {
    const c = corrected[id];
    return c ? { ...seg, text: c.text } : seg;
  });
  const ass = generateAss(segmentsToCues(merged), req.settings.subtitleStyle, {
    width: req.settings.sourceWidth,
    height: req.settings.sourceHeight,
  });
  fs.writeFileSync(assFile, ass, "utf8");
  // Persist the corrected transcript next to the output video so chapter /
  // metadata generation can run later without re-transcribing.
  try {
    const transcriptPath = path.join(req.outDir, path.basename(req.outputPath) + ".transcript.json");
    fs.writeFileSync(transcriptPath, JSON.stringify(merged, null, 2), "utf8");
  } catch { /* best-effort */ }
  return true;
}
