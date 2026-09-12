/**
 * Export-time follow-focus rendering.
 *
 * ARCHITECTURE ("录轨迹，导出渲染"): recording stays a plain 1:1 copy of the
 * screen (zero transform cost — this is what keeps long recordings smooth);
 * only the cursor trajectory is logged (mouse sidecar, ~30ms cadence). At
 * export this module REPLAYS the very same SmartZoom + SpringCamera used live,
 * producing a smooth camera curve, then compiles it into an ffmpeg `zoompan`
 * filtergraph that renders the follow/zoom motion frame-accurately.
 *
 * Pure module (no DOM/electron): unit-testable, runs in the main process.
 */

import { SmartZoom } from "./SmartZoom";
import { SpringCamera } from "./SpringCamera";

export interface MouseTrackSample {
  /** Recording-source ms. */
  tMs: number;
  /** Normalized (0-1) cursor position in the captured frame. */
  x: number;
  y: number;
}

export interface CameraFrame {
  tMs: number;
  /** Camera center, normalized 0-1 of the source. */
  cx: number;
  cy: number;
  /** 1.0 = fit; >1 = zoomed. */
  scale: number;
}

export interface CameraKeyframe extends CameraFrame {}

export interface ReplayConfig {
  sourceWidth: number;
  sourceHeight: number;
  zoomLevel: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Offline replay of the live camera stack. Mirrors Recorder.compose()'s
 * camera block: SmartZoom decides tracking/targets from the cursor samples,
 * the spring eases toward them using the REAL sample intervals as dt, and the
 * eased zoom is fed back for the safe-zone math — identical behaviour to the
 * live preview, just computed after the fact.
 */
export function replayCamera(track: MouseTrackSample[], cfg: ReplayConfig): CameraFrame[] {
  const out: CameraFrame[] = [];
  if (track.length === 0) return out;
  const SW = Math.max(1, cfg.sourceWidth);
  const SH = Math.max(1, cfg.sourceHeight);

  // SmartZoom's teleport/dead-zone thresholds are authored for ~1080p; scale
  // them with the source width so fast flicks on 4K captures aren't mistaken
  // for teleports (which kill follow until the cursor re-appears).
  const smart = new SmartZoom({
    enabled: true,
    zoomLevel: cfg.zoomLevel,
    teleportPx: Math.max(900, cfg.sourceWidth * 0.55),
    deadZonePx: 2.5 * Math.max(1, cfg.sourceWidth / 1920),
  });
  const spring = new SpringCamera();

  let followTarget = { x: 0.5, y: 0.5 };
  let lastT = track[0].tMs;

  for (let i = 0; i < track.length; i++) {
    const s = track[i];
    const dtMs = clamp(s.tMs - lastT, 0, 250);
    lastT = s.tMs;

    const target = smart.process({ x: s.x * SW, y: s.y * SH }, { width: SW, height: SH });
    if (target) followTarget = target;

    const tracking = smart.tracking;
    if (tracking) {
      spring.update(followTarget.x, followTarget.y, dtMs);
    } else {
      spring.update(0.5, 0.5, dtMs);
    }
    spring.updateScale(tracking ? smart.config.zoomLevel : 1.0, dtMs);
    smart.setCurrentZoom(spring.state.scale);

    out.push({ tMs: s.tMs, cx: spring.state.x, cy: spring.state.y, scale: Math.max(1, spring.state.scale) });
  }
  // Tail frame so the very end of the recording has camera coverage.
  out.push({ tMs: lastT, cx: spring.state.x, cy: spring.state.y, scale: Math.max(1, spring.state.scale) });
  return out;
}

/**
 * Keyframe reduction: keeps a frame only when it deviates from the linear
 * prediction of the last two kept frames beyond tolerance, plus a forced
 * keyframe at least every maxGapMs. This is what keeps the generated zoompan
 * expressions small (hundreds of keys, not tens of thousands of frames).
 */
export function downsampleCamera(
  frames: CameraFrame[],
  opts: { posTol?: number; scaleTol?: number; maxGapMs?: number } = {},
): CameraKeyframe[] {
  const posTol = opts.posTol ?? 0.004; // ~0.4% of the frame
  const scaleTol = opts.scaleTol ?? 0.012;
  const maxGapMs = opts.maxGapMs ?? 1500;
  if (frames.length <= 2) return [...frames];

  const keys: CameraKeyframe[] = [frames[0]];
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i];
    const a = keys[keys.length - 1];
    const gap = f.tMs - a.tMs;
    let keep = gap >= maxGapMs;
    if (!keep && keys.length >= 2) {
      const b = keys[keys.length - 2];
      const span = Math.max(1, a.tMs - b.tMs);
      const alpha = Math.min(1.5, gap / span);
      const predX = b.cx + (a.cx - b.cx) * alpha;
      const predY = b.cy + (a.cy - b.cy) * alpha;
      const predS = b.scale + (a.scale - b.scale) * alpha;
      keep =
        Math.abs(f.cx - predX) > posTol ||
        Math.abs(f.cy - predY) > posTol ||
        Math.abs(f.scale - predS) > scaleTol;
    }
    if (keep) keys.push(f);
  }
  const last = frames[frames.length - 1];
  if (keys[keys.length - 1].tMs !== last.tMs) keys.push(last);
  return keys;
}

/** Camera center+scale → viewport top-left in SOURCE pixels (clamped). */
export function viewportRect(
  kf: CameraFrame,
  srcW: number,
  srcH: number,
): { x: number; y: number; w: number; h: number } {
  const w = srcW / Math.max(1, kf.scale);
  const h = srcH / Math.max(1, kf.scale);
  return {
    x: clamp(kf.cx * srcW - w / 2, 0, Math.max(0, srcW - w)),
    y: clamp(kf.cy * srcH - h / 2, 0, Math.max(0, srcH - h)),
    w,
    h,
  };
}

const num = (v: number): string => {
  const s = v.toFixed(4);
  return s === "-0.0000" ? "0" : s.replace(/\.?0+$/, "") || "0";
};
/**
 * Piecewise-linear interpolation over keyframes in a NESTING-SAFE flat form.
 *
 * The naive form (one `if(lt(T,t1),seg,rest)` per segment) nests one layer
 * deeper per segment; libavfilter's expression parser dies somewhere between
 * 60 and 100 nesting levels with a bare EINVAL (encoder never opens, 0 frames
 * rendered) — long recordings hit this within minutes.
 *
 * Flat form instead: a constant base plus one NON-NESTED term per moving
 * segment, using clamped ramps and the zero-nesting `gte()`:
 *   term_i(T) = dv_i * ( clip((T-t0)/(t1-t0),0,1) - gte(T,t1) )
 * The clip ramps 0->1 across [t0,t1]; the -gte(T,t1) cancels the held delta
 * after t1 so consecutive terms chain exactly. Static spans are skipped, so
 * a still camera still compiles to a bare constant.
 */
export function lerpExpression(
  keys: CameraKeyframe[],
  pick: (kf: CameraKeyframe) => number,
  tVar: string,
): string {
  if (keys.length === 0) return "0";
  const vals = keys.map(pick);
  if (keys.length === 1) return num(vals[0]);
  const allEqual = vals.every((v) => Math.abs(v - vals[0]) < 1e-6);
  if (allEqual) return num(vals[0]);

  const terms: string[] = [num(vals[0])];
  for (let i = 0; i < keys.length - 1; i++) {
    const t0 = keys[i].tMs / 1000;
    const t1 = keys[i + 1].tMs / 1000;
    const dv = vals[i + 1] - vals[i];
    if (Math.abs(dv) < 1e-6 || t1 - t0 < 1e-6) continue;
    terms.push(
      `(${num(dv)})*(clip((${tVar}-${num(t0)})/${num(t1 - t0)},0,1)-gte(${tVar},${num(t1)}))`,
    );
  }
  return terms.join("+");
}

export interface ZoompanParams {
  fps: number;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
}

/**
 * Full filtergraph text for the focus pass. zoompan's z/x/y are evaluated
 * per output frame (`on` = output frame index, so T = on/fps). Audio passes
 * through untouched (handled by the runner's mapping).
 */
export function buildZoompanGraph(
  keys: CameraKeyframe[],
  p: ZoompanParams,
): string {
  const fps = Math.max(1, Math.round(p.fps));
  const tVar = `(on/${fps})`;
  const zExpr = lerpExpression(keys, (k) => k.scale, tVar);
  const xExpr = lerpExpression(keys, (k) => viewportRect(k, p.sourceWidth, p.sourceHeight).x, tVar);
  const yExpr = lerpExpression(keys, (k) => viewportRect(k, p.sourceWidth, p.sourceHeight).y, tVar);
  return (
    `[0:v]fps=${fps},format=yuv420p,` +
    `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:` +
    `s=${p.outputWidth}x${p.outputHeight}:fps=${fps}[v]`
  );
}

/** Camera keyframes → normalized viewport rects (for the vertical reframe). */
export function cameraToRects(
  keys: CameraKeyframe[],
  srcW: number,
  srcH: number,
): { tMs: number; x: number; y: number; w: number; h: number }[] {
  return keys.map((k) => {
    const r = viewportRect(k, srcW, srcH);
    return { tMs: k.tMs, x: r.x / srcW, y: r.y / srcH, w: r.w / srcW, h: r.h / srcH };
  });
}

/** Parse the mouse-track JSONL sidecar (tolerant of partial lines). */
export function parseMouseTrack(raw: string): MouseTrackSample[] {
  const out: MouseTrackSample[] = [];
  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const o = JSON.parse(l) as MouseTrackSample;
      if (Number.isFinite(o.tMs) && Number.isFinite(o.x) && Number.isFinite(o.y)) {
        out.push({ tMs: o.tMs, x: clamp(o.x, 0, 1), y: clamp(o.y, 0, 1) });
      }
    } catch { /* skip bad line */ }
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}


/** Camera state at an arbitrary time (binary search + linear interpolation
 *  between replay frames). Used by the frame-by-frame Chromium renderer. */
export function cameraAt(
  frames: CameraFrame[],
  tMs: number,
): { cx: number; cy: number; scale: number } {
  if (frames.length === 0) return { cx: 0.5, cy: 0.5, scale: 1 };
  if (tMs <= frames[0].tMs) return { cx: frames[0].cx, cy: frames[0].cy, scale: frames[0].scale };
  const last = frames[frames.length - 1];
  if (tMs >= last.tMs) return { cx: last.cx, cy: last.cy, scale: last.scale };
  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].tMs <= tMs) lo = mid;
    else hi = mid;
  }
  const a = frames[lo];
  const b = frames[hi];
  const span = Math.max(1e-6, b.tMs - a.tMs);
  const t = (tMs - a.tMs) / span;
  return {
    cx: a.cx + (b.cx - a.cx) * t,
    cy: a.cy + (b.cy - a.cy) * t,
    scale: a.scale + (b.scale - a.scale) * t,
  };
}
