/**
 * Export planner — turns (EDL, settings, paths) into an ordered list of ffmpeg
 * stages. PURE: no fs / spawn / electron here (node:path is fine), so the exact
 * command lines are unit-testable. The runner (run.ts) executes the stages and
 * injects the ASR/LLM step between the audio pass and the subtitle burn.
 *
 * Pipeline order (timestamps stay aligned because every transformation that
 * changes time happens before the ASR step):
 *   1. segments      — EDL cuts removed, speedups compressed  -> seg_*.mp4
 *   2. concat        — stream-copy the segments               -> timeline.mp4
 *   3. audio pass    — silence trim + loudnorm (re-encode)    -> av.mp4
 *   4. ASR           — wav extract + whisper + optional LLM   -> subs.ass
 *   5. subtitle burn — -vf ass (re-encode)                    -> subbed.mp4
 *   6. final concat  — intro + main + outro (re-encode)       -> main.mp4
 *   7. finalize      — copy/move the main line to the output  -> output.mp4
 *   8. vertical      — camera-track sendcmd crop 9:16         -> output_vertical.mp4
 * Stages whose feature is disabled are omitted; with everything disabled the
 * planner emits a single legacy transcode stage.
 */

import path from "node:path";
import { buildTimeline, edlReport, type EdlFile, type MaskEdit, type TimelineSegment } from "../../src/recording/edl";
import { buildFocusSpans, detectZoomRegions, type FocusSpan } from "../../src/recording/zoomRegions";
import type { OccurrenceRun } from "../../src/lib/perceptualHash";

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  position: "bottom" | "middle" | "top";
  marginV: number;
}

export interface ExportSettings {
  fps: number;
  /** Export-time follow-focus render from the mouse track. */
  zoomEnabled: boolean;
  /** Zoom level for the follow-focus render. */
  zoomLevel: number;
  /** Append the built-in brand outro clip (generated at export). */
  brandOutro: boolean;
  /** Windows font file used to render the brand text. */
  brandFontPath: string;
  /** Optional brand logo image overlaid on the brand outro card. */
  brandLogoPath: string;
  /** Brand texts (follows the UI language). */
  brandTitle: string;
  brandSlogan: string;
  trimSilence: boolean;
  silenceThresholdS: number;
  loudnorm: boolean;
  subtitles: boolean;
  subtitleStyle: SubtitleStyle;
  llmEnabled: boolean;
  glossary: string;
  introEnabled: boolean;
  introPath: string;
  introDurationS: number;
  outroEnabled: boolean;
  outroPath: string;
  outroDurationS: number;
  vertical: boolean;
  sourceWidth: number;
  sourceHeight: number;
  verticalWidth: number;
  verticalHeight: number;
}

export interface StageBase {
  kind:
    | "zoomspan"
    | "brand"
    | "segment"
    | "concat"
    | "audio"
    | "asr"
    | "burn"
    | "maskburn"
    | "final-concat"
    | "vertical"
    | "transcode";
  label: string;
  /** ffmpeg args (without the binary); null for hook stages the runner completes. */
  args: string[] | null;
  output: string;
  /** concat stages: the list file to write + its inputs, in order. */
  listFile?: string;
  inputs?: string[];
  /** vertical stage plumbing, filled at plan time, executed by the runner. */
  sendcmdFile?: string;
  camTrackPath?: string;
  verticalWidth?: number;
  verticalHeight?: number;
  /** working directory for filters that take relative paths (ass/sendcmd). */
  cwd?: string;
  /** zoomspan stage: zoom/geometry constants for the static crop. */
  zoomParams?: { depth: number; cx: number; cy: number; ease: "in" | "out" | "hold" | "full" };
}

export interface ExportPlan {
  stages: StageBase[];
  intermediates: string[];
  /** Pixel size of the planned main output (crop size in region recording). */
  outputSize: { w: number; h: number };
  report: {
    cuts: number;
    cutsMs: number;
    masks: number;
    speedups: number;
    sourceDurationMs: number;
    outputDurationMs: number;
  };
}

/** Sensible export bitrate for a target frame size (Mbps): ~12 for 1080p,
 *  ~21 for 1440p, ~40 (cap) for 4K. libopenh264 without an explicit bitrate
 *  defaults to ~2 Mbps, which turns screen content into blocky mush. */
export function bitrateFor(w: number, h: number): number {
  const mp = (Math.max(1, w) * Math.max(1, h)) / 1e6;
  return Math.round(Math.max(6, Math.min(40, mp * 5.8)));
}

/** Encode args bound to an output frame size (bitrate derived from it). */
export function encArgs(w: number, h: number): string[] {
  const b = bitrateFor(w, h);
  return [
    "-c:v", "libopenh264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
    "-b:v", `${b}M`, "-maxrate", `${b}M`, "-bufsize", `${b * 2}M`,
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-video_track_timescale", "90000",
  ];
}

/** ms -> ffmpeg seconds with ms precision. */
export function secs(ms: number): string {
  return (Math.round(ms) / 1000).toFixed(3);
}

function even(v: number): number {
  const r = Math.round(v);
  return r % 2 === 0 ? r : r + 1;
}

// ---------------------------------------------------------------------------
// Privacy mosaic burn (F6 mask promotion to the exported film)
// ---------------------------------------------------------------------------

/** A privacy mask rectangle to burn onto the source timeline, in the pixel
 *  space the burn stage will read (region-cropped when recordRegion is set). */
export interface MaskBurnRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Burn window on the SOURCE timeline, seconds. */
  t0: number;
  t1: number;
}

/**
 * Collapse burn rects that sit on the SAME spot into continuous time spans.
 * The occurrence scan emits one run per visible burst (gap-gated ~1s), so a
 * mask whose content blinks in/out every few seconds yields thousands of
 * near-identical overlay chains (one re-encode-sized overlay op per chain).
 * Merging them into a single window from first to last appearance keeps the
 * same coverage with a tiny fraction of the filters — and a sane command line.
 */
export function coalesceBurnRects(rects: MaskBurnRect[]): MaskBurnRect[] {
  const cell = 32;
  const grid = new Map<string, { x: number; y: number; w: number; h: number; ts: Array<[number, number]> }>();
  for (const r of rects) {
    const k = `${Math.round(r.x * cell)}|${Math.round(r.y * cell)}|${Math.round(r.w * cell)}|${Math.round(r.h * cell)}`;
    let e = grid.get(k);
    if (!e) { e = { x: r.x, y: r.y, w: r.w, h: r.h, ts: [] }; grid.set(k, e); }
    e.ts.push([r.t0, r.t1]);
  }
  const out: MaskBurnRect[] = [];
  for (const e of grid.values()) {
    const ts = e.ts.sort((a, b) => a[0] - b[0]);
    let i = 0;
    while (i < ts.length) {
      let c0 = ts[i][0];
      let c1 = ts[i][1];
      i++;
      while (i < ts.length && ts[i][0] <= c1 + 0.5) {
        c1 = Math.max(c1, ts[i][1]);
        i++;
      }
      out.push({ x: e.x, y: e.y, w: e.w, h: e.h, t0: c0, t1: c1 });
    }
  }
  return out;
}

function validBurnRect(m: MaskBurnRect): boolean {
  return m.t1 > m.t0 + 0.001 &&
    Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.w) && Number.isFinite(m.h) &&
    m.w > 0.01 && m.h > 0.01 && m.x >= -0.02 && m.y >= -0.02 && m.x < 1.02 && m.y < 1.02;
}

/** Max chars a single maskburn -filter_complex graph may use. Windows caps the
 *  process command line at ~32767 chars (CreateProcess) and the bundled ffmpeg
 *  has no script-file fallback, so oversized burns are split into chained
 *  passes kept well under the cap. */
export const BURN_PASS_BUDGET_CHARS = 24000;

/**
 * Build the -filter_complex graph that pixelates each mask rect in place over
 * its source-timeline window. The mosaic is a real pixelation of whatever
 * sits underneath (downscale x12 area + upscale nearest-neighbor), so the
 * private content is unreadable — matching the live overlay mosaic intent.
 * Returns "" when no rect is usable; the caller must then skip the stage.
 */
export function maskBurnGraph(rects: MaskBurnRect[], inW: number, inH: number): string {
  const chains: string[] = [];
  const usable = coalesceBurnRects(rects.filter(validBurnRect));
  let last = "[0:v]";
  usable.forEach((m, i) => {
    let X = Math.round(m.x * inW);
    let Y = Math.round(m.y * inH);
    if (X & 1) X -= 1;
    if (Y & 1) Y -= 1;
    X = Math.max(0, Math.min(inW - 2, X));
    Y = Math.max(0, Math.min(inH - 2, Y));
    let W = Math.min(inW - X, Math.max(2, Math.round(m.w * inW)));
    let H = Math.min(inH - Y, Math.max(2, Math.round(m.h * inH)));
    if (W & 1) W -= 1;
    if (H & 1) H -= 1;
    if (W < 4 || H < 4) return;
    // yuv420p-safe tiny-stage sizes (mosaic cell resolution).
    const sw = Math.max(2, Math.round(W / 12)) & ~1;
    const sh = Math.max(2, Math.round(H / 12)) & ~1;
    const outLabel = i === usable.length - 1 ? "[vout]" : `[o${i}]`;
    chains.push(`${last}split=2[s${i}][t${i}]`);
    chains.push(
      `[t${i}]crop=w=${W}:h=${H}:x=${X}:y=${Y},` +
      `scale=${sw}:${sh}:flags=area,` +
      `scale=${W}:${H}:flags=neighbor[p${i}]`,
    );
    chains.push(`[s${i}][p${i}]overlay=x=${X}:y=${Y}:enable='between(t,${m.t0.toFixed(3)},${m.t1.toFixed(3)})'${outLabel}`);
    last = outLabel;
  });
  return chains.join(";");
}

/** Re-encode stage that bakes the privacy mosaics into the whole recording
 *  (source timeline untouched, so downstream zoom spans / EDL segments keep
 *  slicing the same clock and the mosaic stays glued to the content). */
export function maskBurnStage(
  input: string,
  out: string,
  rects: MaskBurnRect[],
  p: { inW: number; inH: number; fps: number },
): StageBase {
  const W = Math.max(2, Math.round(p.inW) - (Math.round(p.inW) % 2));
  const H = Math.max(2, Math.round(p.inH) - (Math.round(p.inH) % 2));
  return {
    kind: "maskburn",
    label: `burn ${rects.length} privacy mosaic(s)`,
    args: [
      "-y", "-i", input,
      "-filter_complex", maskBurnGraph(rects, W, H),
      "-map", "[vout]", "-map", "0:a?",
      ...encArgs(W, H),
      "-r", String(Math.max(1, Math.round(p.fps))),
      "-movflags", "+faststart",
      out,
    ],
    output: out,
  };
}

// ---------------------------------------------------------------------------
// Stage builders
// ---------------------------------------------------------------------------

/** Extract + encode one timeline segment. `-ss` before `-i` is frame-accurate
 *  when re-encoding (ffmpeg seeks to the keyframe then decodes forward). */
export function segmentStage(
  input: string,
  out: string,
  seg: TimelineSegment,
  fps: number,
  outSize: { w: number; h: number } = { w: 1920, h: 1080 },
): StageBase {
  const dur = seg.srcEndMs - seg.srcStartMs;
  const base: string[] = ["-y", "-ss", secs(seg.srcStartMs), "-t", secs(dur), "-i", input];
  let args: string[];
  if (seg.speed === 1) {
    args = [
      ...base,
      "-map", "0:v:0", "-map", "0:a?",
      ...encArgs(outSize.w, outSize.h),
      "-r", String(fps),
      "-avoid_negative_ts", "make_zero",
      out,
    ];
  } else {
    const outSecs = (seg.outEndMs - seg.outStartMs) / 1000;
    const via = seg.via as { audio: "mute" | "whoosh" };
    if (via.audio === "whoosh") {
      // Video retimed; source audio replaced by a soft filtered-noise "whoosh".
      const fadeStart = Math.max(0, outSecs - 0.3);
      args = [
        ...base,
        "-f", "lavfi", "-i", `anoisesrc=color=pink:r=48000:amplitude=0.35:d=${secs(seg.outEndMs - seg.outStartMs)}`,
        "-filter_complex",
        `[0:v]setpts=PTS/${seg.speed.toFixed(6)}[v];` +
        `[1:a]lowpass=f=900,afade=t=in:st=0:d=0.3,afade=t=out:st=${secs(fadeStart * 1000)}:d=0.3[a]`,
        "-map", "[v]", "-map", "[a]",
        ...encArgs(outSize.w, outSize.h),
        "-r", String(fps),
        "-avoid_negative_ts", "make_zero",
        out,
      ];
    } else {
      args = [
        ...base,
        "-vf", `setpts=PTS/${seg.speed.toFixed(6)}`,
        "-an",
        ...encArgs(outSize.w, outSize.h),
        "-r", String(fps),
        "-avoid_negative_ts", "make_zero",
        out,
      ];
    }
  }
  return { kind: "segment", label: `segment ${secs(seg.srcStartMs)}s @${seg.speed.toFixed(2)}x`, args, output: out };
}

export function concatListContent(inputs: string[]): string {
  return inputs.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

export function concatArgs(listFile: string, out: string, reencode: boolean, fps = 30, size: { w: number; h: number } = { w: 1920, h: 1080 }): string[] {
  const common = ["-y", "-f", "concat", "-safe", "0", "-i", listFile];
  if (reencode) return [...common, ...encArgs(size.w, size.h), "-r", String(fps), "-movflags", "+faststart", out];
  return [...common, "-c", "copy", "-movflags", "+faststart", out];
}

export function audioPassStage(
  input: string,
  out: string,
  opts: { trimSilence: boolean; silenceThresholdS: number; loudnorm: boolean; fps: number; w?: number; h?: number },
): StageBase {
  const af: string[] = [];
  if (opts.trimSilence && opts.silenceThresholdS > 0) {
    // Legacy-compatible threshold: the filter takes a fraction of full scale.
    af.push(`silenceremove=stop_periods=-1:stop_threshold=${opts.silenceThresholdS * 0.01}`);
  }
  if (opts.loudnorm) af.push("loudnorm=I=-16:TP=-1.5:LRA=11");
  return {
    kind: "audio",
    label: `audio pass (${af.join(" + ") || "passthrough"})`,
    args: ["-y", "-i", input, ...(af.length ? ["-af", af.join(",")] : []), ...encArgs(opts.w ?? 1920, opts.h ?? 1080), "-r", String(opts.fps), "-movflags", "+faststart", out],
    output: out,
  };
}

export function burnStage(input: string, out: string, assPath: string, fps: number, size: { w: number; h: number } = { w: 1920, h: 1080 }): StageBase {
  return {
    kind: "burn",
    label: "burn subtitles",
    // ass filter uses a RELATIVE path: the runner sets cwd to the work dir,
    // which sidesteps the Windows drive-colon escaping in lavfi filter args.
    args: ["-y", "-i", input, "-vf", `ass=${path.basename(assPath)}`, ...encArgs(size.w, size.h), "-r", String(fps), "-movflags", "+faststart", out],
    output: out,
    cwd: path.dirname(assPath),
  };
}

const zxConst = (c: number): string => c.toFixed(6);
const zyConst = (c: number): string => c.toFixed(6);

/**
 * One Recordly-style zoom span. Flavors:
 *  - "hold" / "full": CONSTANT crop+scale (zero jitter where it matters).
 *  - "in" / "out": zoompan with a short depth ramp (Recordly: 1523/1015ms).
 *  - "glide": constant depth, camera pans from the previous focus to this
 *    span's focus over the span duration (Recordly connected zoom, 1000ms).
 */
export function zoomSpanStage(
  input: string,
  out: string,
  span: FocusSpan,
  p: {
    fps: number;
    width: number;
    height: number;
    ease: "in" | "out" | "hold" | "glide" | "full";
    /** glide: where the camera is coming FROM (normalized focus of the
     *  previous span, at depth 1 for full-frame spans). */
    fromCx?: number;
    fromCy?: number;
    fromDepth?: number;
  },
): StageBase {
  const dur = span.endMs - span.startMs;
  const depth = Math.max(1, span.depth);
  const secs = (ms: number) => (Math.round(ms) / 1000).toFixed(3);
  const cw = Math.round(p.width / depth);
  const ch = Math.round(p.height / depth);
  const cx = Math.round(Math.max(0, Math.min(p.width - cw, span.cx * p.width - cw / 2)));
  const cy = Math.round(Math.max(0, Math.min(p.height - ch, span.cy * p.height - ch / 2)));

  let vf: string;
  if (p.ease === "hold" || p.ease === "full") {
    vf = `crop=w=${cw}:h=${ch}:x=${cx}:y=${cy},scale=${p.width}:${p.height}`;
  } else if (p.ease === "glide") {
    // Constant depth; x/y pan from the previous focus to this one.
    const D = depth;
    const fromX = (p.fromCx ?? 0.5) * p.width;
    const fromY = (p.fromCy ?? 0.5) * p.height;
    const toX = span.cx * p.width;
    const toY = span.cy * p.height;
    // zoompan x/y are evaluated per output frame (`on`), clamp keeps the crop
    // inside the frame; z stays constant.
    const tN = `(on/${p.fps})/${(dur / 1000).toFixed(3)}`;
    const ss = `(${tN})*(${tN})*(3-2*(${tN}))`;
    const lerpX = `(${fromX.toFixed(1)})+(${(toX - fromX).toFixed(1)})*(${ss})`;
    const lerpY = `(${fromY.toFixed(1)})+(${(toY - fromY).toFixed(1)})*(${ss})`;
    const xExpr = `max(0,min(iw-iw/zoom,${lerpX}-iw/zoom/2))`;
    const yExpr = `max(0,min(ih-ih/zoom,${lerpY}-ih/zoom/2))`;
    vf = `zoompan=z='${D.toFixed(4)}':x='${xExpr}':y='${yExpr}':d=1:s=${p.width}x${p.height}:fps=${p.fps}`;
  } else {
    // Smoothstep ramp (3u^2 - 2u^3): zero velocity at both ends, matching
    // the spring-driven feel of Recordly's transitions (no constant-speed
    // crawl, no abrupt stop). u = clip(t/D, 0, 1); D = span duration.
    const D = depth;
    const u = `clip((on/${p.fps})/${(dur / 1000).toFixed(3)},0,1)`;
    const smooth = `(${u})*(${u})*(3-2*(${u}))`;
    const zramp =
      p.ease === "in"
        ? `1+(${(D - 1).toFixed(4)})*(${smooth})`
        : `${D.toFixed(4)}-(${(D - 1).toFixed(4)})*(${smooth})`;
    const xExpr = `max(0,min(iw-iw/zoom,${zxConst(span.cx)}*iw-iw/zoom/2))`;
    const yExpr = `max(0,min(ih-ih/zoom,${zyConst(span.cy)}*ih-ih/zoom/2))`;
    vf = `zoompan=z='${zramp}':x='${xExpr}':y='${yExpr}':d=1:s=${p.width}x${p.height}:fps=${p.fps}`;
  }

  return {
    kind: "zoomspan",
    label: `zoom span ${secs(span.startMs)}s ${span.depth > 1 ? `x${depth.toFixed(2)} @${span.cx.toFixed(2)},${span.cy.toFixed(2)}` : "full"} (${p.ease})`,
    args: [
      "-y", "-ss", secs(span.startMs), "-t", secs(dur), "-i", input,
      "-vf", vf,
      "-map", "0:v:0", "-map", "0:a?",
      ...encArgs(p.width, p.height),
      "-r", String(p.fps),
      "-avoid_negative_ts", "make_zero",
      out,
    ],
    output: out,
  };
}

export function extractWavStage(input: string, out: string): StageBase {
  return {
    kind: "transcode",
    label: "extract mono 16k wav for ASR",
    args: ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out],
    output: out,
  };
}



export interface BrandParams {
  fps: number;
  width: number;
  height: number;
  fontPath: string;
  title: string;
  slogan: string;
  durationS?: number;
}

function escDrawtext(t: string): string {
  return t.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * Built-in brand outro: a 2.8s dark card with the brand LOGO + product name and
 * slogan fading in/out — generated at export time via lavfi (no bundled asset).
 * Silent stereo track keeps the final concat uniform.
 */
export function brandStage(out: string, p: BrandParams): StageBase {
  const fps = Math.max(1, Math.round(p.fps));
  const D = p.durationS ?? 2.8;
  const font = p.fontPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const title = escDrawtext(p.title);
  const slogan = escDrawtext(p.slogan);
  const titleSize = Math.round(p.height * 0.096);
  const sloganSize = Math.round(p.height * 0.037);
  const fadeOutAt = (D - 0.7).toFixed(2);
  const alphaMain = `if(lt(t,0.35),0,if(lt(t,1.15),(t-0.35)/0.8,if(lt(t,${fadeOutAt}),1,(${D}-t)/0.7)))`;
  const alphaSub = `if(lt(t,0.70),0,if(lt(t,1.50),(t-0.70)/0.8,if(lt(t,${fadeOutAt}),1,(${D}-t)/0.7)))`;
  const vf =
    `drawtext=fontfile='${font}':text='${title}':fontcolor=0xE8E8F0:fontsize=${titleSize}:x=(w-text_w)/2:y=(h-text_h)/2-(h*0.045):alpha='${alphaMain}',` +
    `drawtext=fontfile='${font}':text='${slogan}':fontcolor=0x9090A8:fontsize=${sloganSize}:x=(w-text_w)/2:y=(h-text_h)/2+(h*0.055):alpha='${alphaSub}'`;
  return {
    kind: "brand",
    label: "brand outro",
    args: [
      "-y",
      "-f", "lavfi", "-i", `color=c=0x0a0a0f:s=${p.width}x${p.height}:r=${fps}:d=${D}`,
      "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${D}`,
      "-vf", vf,
      "-map", "0:v", "-map", "1:a",
      ...encArgs(p.width, p.height),
      "-r", String(fps),
      "-movflags", "+faststart",
      out,
    ],
    output: out,
  };
}

/**
 * Second brand pass: overlay the brand LOGO onto the text brand card. The logo
 * is scaled to min(28% W, 38% H), centered, bottom ~13% above the card centre
 * (clears the title row), and faded in/out on the text card's timeline.
 * Kept as a separate stage: drawtexton-text works with a plain -vf chain,
 * while a drawtext + overlay combo inside one -filter_complex hits a graph
 * parser quirk in the bundled ffmpeg, so the logo rides its own overlay pass.
 */
export function brandLogoStage(
  inPath: string,
  out: string,
  p: { fps: number; width: number; height: number; logoPath: string },
): StageBase {
  const fps = Math.max(1, Math.round(p.fps));
  const D = 2.8;
  const fadeOutAt = (D - 0.7).toFixed(2);
  const logoW = Math.round(Math.max(60, Math.min(p.width * 0.28, p.height * 0.38)));
  const filterComplex =
    `[1:v]scale=${logoW}:-1,format=rgba,fade=t=in:st=0.3:d=0.8:alpha=1,fade=t=out:st=${fadeOutAt}:d=0.7:alpha=1[lg];` +
    `[0:v][lg]overlay=x=(W-w)/2:y=H*0.37-h:shortest=1[v]`;
  return {
    kind: "brand",
    label: "brand logo outro",
    args: [
      "-y",
      "-i", inPath,
      "-loop", "1", "-framerate", String(fps), "-i", p.logoPath.replace(/\\/g, "/"),
      "-filter_complex", filterComplex,
      "-map", "[v]", "-map", "0:a",
      ...encArgs(p.width, p.height),
      "-c:a", "copy",
      "-movflags", "+faststart",
      out,
    ],
    output: out,
  };
}

// ---------------------------------------------------------------------------
// Vertical reframe (camera-track sendcmd)
// ---------------------------------------------------------------------------

export interface CameraSample {
  tMs: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VerticalGeometry {
  cropW: number;
  cropH: number;
  /** sendcmd script content; a single centered entry when the track is empty. */
  sendcmd: string;
}

/**
 * 9:16 crop geometry following the recorded camera window horizontally: the
 * crop keeps the full source height, its width = height * (targetW/targetH),
 * and x tracks the camera center (clamped). Empty tracks -> centered static.
 */
export function verticalGeometry(
  samples: CameraSample[],
  srcW: number,
  srcH: number,
  targetW = 1080,
  targetH = 1920,
): VerticalGeometry {
  const cropH = even(srcH);
  const cropW = even(Math.min(srcW, Math.max(2, srcH * (targetW / targetH))));
  const clampX = (x: number): number => Math.max(0, Math.min(srcW - cropW, x));
  if (!samples.length) {
    return { cropW, cropH, sendcmd: `0.000 crop x ${Math.round((srcW - cropW) / 2)};\n` };
  }
  const lines: string[] = [];
  for (const s of samples) {
    const centerX = (s.x + s.w / 2) * srcW;
    const x = Math.round(clampX(centerX - cropW / 2));
    lines.push(`${(s.tMs / 1000).toFixed(3)} crop x ${x};`);
  }
  return { cropW, cropH, sendcmd: lines.join("\n") + "\n" };
}

export function verticalArgs(
  input: string,
  out: string,
  geo: VerticalGeometry,
  sendcmdFile: string,
  targetW = 1080,
  targetH = 1920,
  fps = 30,
): string[] {
  return [
    "-y", "-i", input,
    "-vf", `sendcmd=f=${path.basename(sendcmdFile)},crop=w=${geo.cropW}:h=${geo.cropH}:x=0:y=0,scale=${even(targetW)}:${even(targetH)}`,
    ...encArgs(even(targetW), even(targetH)),
    "-r", String(fps),
    "-movflags", "+faststart",
    out,
  ];
}

// ---------------------------------------------------------------------------
// Whole-plan assembly
// ---------------------------------------------------------------------------

export interface PlanInput {
  inputPath: string;
  outputPath: string;
  workDir: string;
  edl: EdlFile;
  durationMs: number;
  settings: ExportSettings;
  camTrackPath?: string;
  /** Mouse trajectory sidecar samples (Recordly-style zoom regions). */
  mouseTrack?: { tMs: number; x: number; y: number }[];
  /** Region-recording crop (normalized primary-screen), if set. */
  recordRegion?: { x: number; y: number; w: number; h: number } | null;
  /** Probed pixel size of the captured video — the basis for mapping the
   *  normalized region to crop pixels (settings.resolution only sizes
   *  canvas-mode recordings; raw captures keep the display's native size). */
  inputVideoSize?: { width: number; height: number } | null;
  /** Per-mask occurrence runs from the export-time scanner (aligned with the
   *  mask edits order): extra mosaics where the masked content reappears at
   *  a different spot. Absent = no occurrence scan was run. */
  maskTracks?: OccurrenceRun[][];
}

export function hasEdits(edl: EdlFile): boolean {
  return edl.edits.length > 0;
}

export function planExport(input: PlanInput): ExportPlan {
  const { inputPath, outputPath, workDir, edl, durationMs, settings } = input;
  const stages: StageBase[] = [];
  const intermediates: string[] = [];
  const rep = edlReport(edl, durationMs);
  const fps = Math.max(1, Math.min(120, Math.round(settings.fps || 60)));

  const timeline = path.join(workDir, "timeline.mp4");
  const av = path.join(workDir, "av.mp4");
  const subbed = path.join(workDir, "subbed.mp4");
  const mainFinal = path.join(workDir, "main.mp4");
  const wav = path.join(workDir, "audio16k.wav");
  const assFile = path.join(workDir, "subs.ass");

  // 0. Recordly-style zoom regions: mouse dwells become static-focus zoom
  //    spans (ease in -> hold -> ease out). Each span is rendered as a fixed
  //    crop/scale — trivially fast and perfectly smooth. Runs FIRST so EDL
  //    segments slice the zoomed intermediate (track time == source time).
  // Region-recording crop runs FIRST (input is the full captured frame;
  // everything downstream — zoom regions, vertical — works in cropped space).
  let pipelineInput = inputPath;
  let srcW = settings.sourceWidth;
  let srcH = settings.sourceHeight;
  const rr = input.recordRegion;
  if (rr && rr.w > 0.02 && rr.h > 0.02) {
    // Map the normalized region onto the ACTUAL captured pixels (probed);
    // clamp to the frame so rounding can never push the crop out of bounds.
    const inW = Math.max(2, input.inputVideoSize?.width || settings.sourceWidth);
    const inH = Math.max(2, input.inputVideoSize?.height || settings.sourceHeight);
    const cropped = path.join(workDir, "cropped.mp4");
    intermediates.push(cropped);
    const cw = Math.max(2, Math.min(inW - (inW % 2), Math.round((inW * rr.w) / 2) * 2));
    const ch = Math.max(2, Math.min(inH - (inH % 2), Math.round((inH * rr.h) / 2) * 2));
    const cx = Math.max(0, Math.min(inW - cw, Math.round(inW * rr.x)));
    const cy = Math.max(0, Math.min(inH - ch, Math.round(inH * rr.y)));
    stages.push({
      kind: "zoomspan",
      label: `region crop ${rr.w.toFixed(2)}x${rr.h.toFixed(2)}`,
      args: [
        "-y", "-i", inputPath,
        "-vf", `crop=w=${cw}:h=${ch}:x=${cx}:y=${cy}`,
        "-map", "0:v:0", "-map", "0:a?",
        ...encArgs(cw, ch),
        "-r", String(fps),
        cropped,
      ],
      output: cropped,
    });
    pipelineInput = cropped;
    srcW = cw;
    srcH = ch;
  }

  // Privacy mosaics burn onto the SOURCE timeline BEFORE any geometry change
  // (zoom spans re-crop, EDL segments re-slice) so the mosaic stays glued to
  // the content and the film covers the private information from its TRUE
  // first appearance — the live overlay box is only on screen from the F6
  // press onward, and may not be captured at all when recording a window.
  const maskEdits = edl.edits.filter((e): e is MaskEdit => e.type === "mask");
  if (maskEdits.length > 0) {
    // Pixel geometry of the burn input: the cropped size after a region
    // recording crop, otherwise the probed source size (settings dims are
    // only a canvas-mode fallback — raw captures keep the native size).
    const efW = Math.max(2, rr && rr.w > 0.02 && rr.h > 0.02 ? srcW : (input.inputVideoSize?.width || srcW));
    const efH = Math.max(2, rr && rr.w > 0.02 && rr.h > 0.02 ? srcH : (input.inputVideoSize?.height || srcH));
    const maskRecs: MaskBurnRect[] = [];
    maskEdits.forEach((m, mi) => {
      let x = m.region.x, y = m.region.y, w = m.region.w, h = m.region.h;
      if (rr && rr.w > 0.02 && rr.h > 0.02) {
        // Map the full-capture normalized rect into the cropped space.
        x = (m.region.x - rr.x) / rr.w;
        y = (m.region.y - rr.y) / rr.h;
        w = m.region.w / rr.w;
        h = m.region.h / rr.h;
      }
      // The region stays hidden for the WHOLE recording, not just until the
      // F6 box was closed: content already on screen before the F6 press
      // (backtraced start) and whatever appears there afterwards are equally
      // private — over-masking beats leaking a single frame.
      const t1 = Math.max(m.endMs, durationMs) / 1000;
      maskRecs.push({ x, y, w, h, t0: m.startMs / 1000, t1 });

      // Occurrence runs: EVERY frame where the masked content shows up at
      // another spot (page scrolled / window moved) gets its own mosaic. The
      // position is layout-bound, so the runs sit in the same relative band —
      // independently remapped into cropped space below. Pad each run so a
      // transient detection never leaves a stray uncovered frame.
      const runs = input.maskTracks?.[mi] ?? [];
      for (const run of runs) {
        let rx = run.rect.x, ry = run.rect.y, rw = run.rect.w, rh = run.rect.h;
        if (rr && rr.w > 0.02 && rr.h > 0.02) {
          rx = (run.rect.x - rr.x) / rr.w;
          ry = (run.rect.y - rr.y) / rr.h;
          rw = run.rect.w / rr.w;
          rh = run.rect.h / rr.h;
        }
        if (rx + rw < 0 || ry + rh < 0 || rx > 1 || ry > 1) continue;
        const r0 = Math.max(0, run.t0 / 1000 - 0.5);
        const r1 = run.t1 / 1000 + 0.5;
        if (r1 - r0 <= 0.05) continue;
        maskRecs.push({ x: rx, y: ry, w: rw, h: rh, t0: r0, t1: r1 });
      }
    });
    const burnRects = coalesceBurnRects(maskRecs.filter(validBurnRect));
    if (burnRects.length > 0) {
      // A real burn can carry thousands of rects (content blinking in/out at
      // many spots); each rect is ~176 chars of filtergraph and Windows caps
      // the command line at ~32767 — so chunk the rects into chained passes
      // whose graphs stay under BURN_PASS_BUDGET_CHARS. Extra re-encode passes
      // cost time but guarantee the export can never die with ENAMETOOLONG.
      const graphLen = maskBurnGraph(burnRects, efW, efH).length;
      const passes = graphLen <= BURN_PASS_BUDGET_CHARS ? 1 : Math.ceil(graphLen / BURN_PASS_BUDGET_CHARS);
      const perPass = Math.max(1, Math.ceil(burnRects.length / passes));
      let src = pipelineInput;
      for (let pi = 0, off = 0; off < burnRects.length; pi++, off += perPass) {
        const chunk = burnRects.slice(off, off + perPass);
        const masked = path.join(workDir, off + perPass >= burnRects.length ? "masked.mp4" : `masked_${pi}.mp4`);
        const stage = maskBurnStage(src, masked, chunk, { inW: efW, inH: efH, fps });
        stage.label = passes === 1
          ? `burn ${chunk.length} privacy mosaic(s)`
          : `burn ${chunk.length}/${burnRects.length} privacy mosaic(s)`;
        intermediates.push(masked);
        stages.push(stage);
        src = masked;
      }
      pipelineInput = src;
    }
  }

  // Zoom regions in CROPPED space: remap track coords into the crop.
  const rr2 = rr ?? null;
  const remappedTrack = (input.mouseTrack ?? []).map((m) => ({
    tMs: m.tMs,
    x: rr2 ? (m.x - rr2.x) / rr2.w : m.x,
    y: rr2 ? (m.y - rr2.y) / rr2.h : m.y,
  })).filter((m) => m.x >= -0.02 && m.x <= 1.02 && m.y >= -0.02 && m.y <= 1.02)
    .map((m) => ({ ...m, x: Math.max(0, Math.min(1, m.x)), y: Math.max(0, Math.min(1, m.y)) }));

  const regions = settings.zoomEnabled
    ? detectZoomRegions(remappedTrack, {
        depth: settings.zoomLevel ?? 1.5,
        dwellMs: 400,
        radius: 0.08,
      })
    : [];
  const focusSpans: FocusSpan[] = regions.length
    ? buildFocusSpans(regions, durationMs, 400)
    : [];
  if (focusSpans.length) {
    const spanFiles: string[] = [];
    focusSpans.forEach((span, i) => {
      const f = path.join(workDir, `zoom_${i}.mp4`);
      spanFiles.push(f);
      intermediates.push(f);
      const prevSpan = i > 0 ? focusSpans[i - 1] : null;
      const prevDepth = prevSpan ? prevSpan.depth : 1;
      let ease: "in" | "out" | "hold" | "glide" | "full" = "hold";
      if (span.depth === 1 && prevDepth === 1) ease = "full";
      else if (span.depth === 1) ease = "out";
      else if (prevDepth === 1) ease = "in";
      else if (prevSpan && (prevSpan.cx !== span.cx || prevSpan.cy !== span.cy)) ease = "glide";
      stages.push(zoomSpanStage(pipelineInput, f, span, {
        fps,
        width: srcW,
        height: srcH,
        ease,
        fromCx: prevSpan ? prevSpan.cx : 0.5,
        fromCy: prevSpan ? prevSpan.cy : 0.5,
        fromDepth: prevDepth,
      }));
    });
    const listFile = path.join(workDir, "zoom_concat.txt");
    const zoomed = path.join(workDir, "zoomed.mp4");
    intermediates.push(listFile, zoomed);
    stages.push({
      kind: "concat",
      label: `concat ${spanFiles.length} zoom span(s)`,
      args: null,
      output: zoomed,
      listFile,
      inputs: spanFiles,
    });
    pipelineInput = zoomed;
  }

  // Masks never change the timeline (they pass time through at 1x), so only
  // cuts/speedups need the segment slice — a mask-only film avoids a wasteful
  // re-encode on top of the mask burn.
  const needsSegments = edl.edits.some((e) => e.type === "cut" || e.type === "speedup");
  const needsAudioPass = settings.trimSilence || settings.loudnorm;
  const needsBurn = settings.subtitles;
  const brandOn = settings.brandOutro;
  const needsFinalConcat = (settings.introEnabled && !!settings.introPath) || (settings.outroEnabled && !!settings.outroPath) || brandOn;

  if (needsSegments) {
    const segments = buildTimeline(edl, durationMs);
    const segFiles: string[] = [];
    segments.forEach((seg, i) => {
      const f = path.join(workDir, `seg_${i}.mp4`);
      segFiles.push(f);
      intermediates.push(f);
      stages.push(segmentStage(pipelineInput, f, seg, fps, { w: srcW, h: srcH }));
    });
    const listFile = path.join(workDir, "concat.txt");
    intermediates.push(listFile, timeline);
    stages.push({
      kind: "concat",
      label: `concat ${segFiles.length} segment(s)`,
      args: null,
      output: timeline,
      listFile,
      inputs: segFiles,
    });
  }

  let current = needsSegments ? timeline : pipelineInput;

  if (needsAudioPass) {
    intermediates.push(av);
    stages.push(audioPassStage(current, av, {
      trimSilence: settings.trimSilence,
      silenceThresholdS: settings.silenceThresholdS,
      loudnorm: settings.loudnorm,
      fps,
      w: srcW,
      h: srcH,
    }));
    current = av;
  }

  if (needsBurn) {
    intermediates.push(wav, assFile, subbed);
    stages.push(extractWavStage(current, wav));
    stages.push({ kind: "asr", label: "transcribe + optional LLM correction", args: null, output: assFile });
    stages.push(burnStage(current, subbed, assFile, fps, { w: srcW, h: srcH }));
    current = subbed;
  }

  if (needsFinalConcat) {
    const parts: string[] = [];
    if (settings.introEnabled && settings.introPath) parts.push(settings.introPath);
    parts.push(current);
    if (settings.outroEnabled && settings.outroPath) parts.push(settings.outroPath);
    if (brandOn) {
      const hasLogo = !!settings.brandLogoPath;
      const textOut = hasLogo ? path.join(workDir, "brand_text.mp4") : path.join(workDir, "brand.mp4");
      intermediates.push(textOut);
      stages.push(brandStage(textOut, {
        fps,
        width: srcW,
        height: srcH,
        fontPath: settings.brandFontPath,
        title: settings.brandTitle,
        slogan: settings.brandSlogan,
      }));
      let brandOut = textOut;
      if (hasLogo) {
        // Logo pass overlays the brand mark onto the text card.
        brandOut = path.join(workDir, "brand.mp4");
        intermediates.push(brandOut);
        stages.push(brandLogoStage(textOut, brandOut, {
          fps,
          width: srcW,
          height: srcH,
          logoPath: settings.brandLogoPath,
        }));
      }
      parts.push(brandOut); // brand card is always the very last thing
    }
    const listFile = path.join(workDir, "final_concat.txt");
    intermediates.push(listFile, mainFinal);
    stages.push({
      kind: "final-concat",
      label: `concat ${parts.length} part(s) with intro/outro`,
      args: null,
      output: mainFinal,
      listFile,
      inputs: parts,
    });
    current = mainFinal;
  }

  if (current === inputPath) {
    // Nothing at all to transform: single legacy-style transcode.
    stages.push({
      kind: "transcode",
      label: "transcode to mp4",
      args: ["-y", "-i", pipelineInput, ...encArgs(srcW, srcH), "-r", String(fps), "-movflags", "+faststart", outputPath],
      output: outputPath,
    });
  } else if (current !== outputPath) {
    stages.push({
      kind: "transcode",
      label: "finalize (stream copy)",
      args: ["-y", "-i", current, "-c", "copy", "-movflags", "+faststart", outputPath],
      output: outputPath,
    });
  }

  if (settings.vertical) {
    const vOut = outputPath.replace(/\.mp4$/i, "") + "_vertical.mp4";
    const sendcmdFile = path.join(workDir, "vertical_sendcmd.txt");
    intermediates.push(sendcmdFile, vOut);
    stages.push({
      kind: "vertical",
      label: "vertical 9:16 reframe",
      args: null,
      output: vOut,
      sendcmdFile,
      camTrackPath: input.camTrackPath ?? "",
      verticalWidth: settings.verticalWidth,
      verticalHeight: settings.verticalHeight,
      cwd: workDir,
    });
  }

  return {
    stages,
    intermediates,
    outputSize: { w: srcW, h: srcH },
    report: {
      cuts: rep.cuts.count,
      cutsMs: rep.cuts.totalMs,
      masks: rep.masks.count,
      speedups: rep.speedups.count,
      sourceDurationMs: durationMs,
      outputDurationMs: rep.outputDurationMs,
    },
  };
}
