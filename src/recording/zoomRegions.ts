/**
 * Recordly-style auto zoom regions (borrowed from Recordly's ZoomRegion
 * model — see recordly_ref/src/types.ts).
 *
 * Instead of continuously chasing the cursor (which renders as jittery pans),
 * we detect WHERE the presenter stopped and worked, and carve discrete zoom
 * regions: zoom in to a STATIC focus, hold, zoom back out. Within a region
 * the camera doesn't move at all — that is what makes the output silky.
 *
 * Pure module: unit-testable, shared by planner and UI.
 */

export interface TrackPoint {
  tMs: number;
  /** Normalized (0-1) in the captured frame. */
  x: number;
  y: number;
}

export interface ZoomRegion {
  startMs: number;
  endMs: number;
  depth: number;
  /** Normalized focus center. */
  cx: number;
  cy: number;
}

export interface RegionOptions {
  depth: number;
  /** Cursor must stay within `radius` (fraction of width) for this long to
   *  count as "working here". */
  dwellMs: number;
  /** Dwell cluster radius (fraction of width). */
  radius: number;
  /** Zoom starts this long BEFORE the dwell begins. */
  leadInMs: number;
  /** Zoom returns this long AFTER the dwell ends. */
  holdMs: number;
  /** Dwells closer than this in time merge into one region. */
  mergeGapMs: number;
  /** Regions shorter than this are dropped. */
  minRegionMs: number;
  /** Hard cap on regions per recording — every region expands into 3-5
   *  ffmpeg stages (zoom in / hold / glide / zoom out), each a separate
   *  encode process; past ~20 the export cost dwarfs the storytelling. */
  maxRegions: number;
  /** While zoomed, the focus point is kept at least this far from the
   *  VIEWPORT edge (fraction of viewport) — clicking near the screen edge
   *  must not park the subject on the frame border. */
  focusMargin: number;
  /** A merged region whose focus points drift further apart than this
   *  (fraction of width) splits instead — slow drifts become connected
   *  GLIDES that follow the work, not one mega-region frozen at an
   *  averaged focus between two workplaces. */
  driftSplit: number;
}

/**
 * Recordly zoom timing (borrowed from recordly_ref/src/types.ts):
 *  - zoom-in takes ~1.5s and starts BEFORE the dwell settles (overlap 500ms
 *    with the cursor still moving into place);
 *  - the zoomed state HOLDS while the cursor keeps working there;
 *  - zoom-out takes ~1s and only begins after the cursor LEAVES the area;
 *  - a new dwell within 1.5s of the previous one is a "connected zoom":
 *    glide straight to the new focus without collapsing to full frame.
 */
export const ZOOM_IN_MS = 1523;
export const ZOOM_OUT_MS = 1015;
export const CONNECTED_ZOOM_GAP_MS = 1500;
export const CONNECTED_ZOOM_MS = 1000;

export const DEFAULT_REGION_OPTIONS: RegionOptions = {
  depth: 1.5,
  dwellMs: 400,
  radius: 0.08,
  leadInMs: 700, // start easing in while the cursor is still arriving
  holdMs: 1200, // stay zoomed a moment after the last activity (exit delay)
  mergeGapMs: CONNECTED_ZOOM_GAP_MS,
  minRegionMs: 1500,
  maxRegions: 20,
  focusMargin: 0.12, // focus stays >=12% away from the viewport edge
  driftSplit: 0.30,  // beyond this the camera GLIDES to follow, not freezes
};

/** Exit hysteresis: a brief excursion out of the dwell radius (boundary
 *  jitter, a quick reach for a scrollbar) must not split a working session.
 *  Excursions shorter than this rejoin the same cluster; a jump beyond
 *  radius*2.5 (a real hand-off) breaks it immediately. */
const DWELL_EXIT_HYSTERESIS_MS = 200;
const DWELL_TELEPORT_FACTOR = 2.5;

interface Cluster {
  cx: number;
  cy: number;
  startMs: number;
  endMs: number;
  samples: number;
}

/** Anchor-based dwell clusters: a cluster is anchored at its first sample;
 *  samples within `radius` of the running centroid extend it. (A pure
 *  centroid anchor would rubber-band across minutes of slow wandering and
 *  glue unrelated activity into one giant "dwell".)
 *
 *  Hysteresis: the first out-of-radius sample starts a grace window instead
 *  of breaking the cluster; if the cursor returns within the window (and
 *  never jumped beyond the teleport factor) the excursion counts as the
 *  same working session. */
export function detectDwells(
  track: TrackPoint[],
  opts: Pick<RegionOptions, "dwellMs" | "radius">,
): Cluster[] {
  const clusters: Cluster[] = [];
  if (track.length === 0) return clusters;
  const radius = Math.max(0.01, opts.radius);

  let cur: Cluster | null = null;
  let outSince: TrackPoint | null = null; // first sample of the current excursion
  const flush = () => {
    if (cur && cur.endMs - cur.startMs >= opts.dwellMs && cur.samples >= 2) {
      clusters.push(cur);
    }
    cur = null;
    outSince = null;
  };
  const anchor = (p: TrackPoint) => {
    cur = { cx: p.x, cy: p.y, startMs: p.tMs, endMs: p.tMs, samples: 1 };
    outSince = null;
  };
  const absorb = (p: TrackPoint) => {
    cur!.cx = (cur!.cx * cur!.samples + p.x) / (cur!.samples + 1);
    cur!.cy = (cur!.cy * cur!.samples + p.y) / (cur!.samples + 1);
    cur!.samples++;
    cur!.endMs = p.tMs;
  };

  for (const p of track) {
    if (!cur) {
      // Inline (not via anchor()) so TS keeps the union type across iterations.
      cur = { cx: p.x, cy: p.y, startMs: p.tMs, endMs: p.tMs, samples: 1 };
      outSince = null;
      continue;
    }
    const dist = Math.hypot(p.x - cur.cx, p.y - cur.cy);
    if (dist <= radius) {
      absorb(p);
      outSince = null;
      continue;
    }
    // Out of radius: teleport-scale jumps break at once; small excursions
    // get the grace window before the session is declared over.
    if (dist > radius * DWELL_TELEPORT_FACTOR) {
      flush();
      anchor(p);
      continue;
    }
    if (!outSince) {
      outSince = p;
      continue;
    }
    if (p.tMs - outSince.tMs > DWELL_EXIT_HYSTERESIS_MS) {
      // The excursion stuck — end the session and restart at the point the
      // cursor actually left (not at the current sample).
      const exc = outSince;
      flush();
      anchor(exc);
      absorb(p);
    }
    // else: still inside the grace window — wait (time keeps flowing into
    // the session only if the cursor returns).
  }
  flush();
  return clusters;
}

/**
 * Detect zoom regions: dwell clusters become regions with lead-in/hold and
 * depth; nearby regions merge; overlapping regions are clipped.
 *
 * `clicks` (global click timestamps+positions from the recording sidecar)
 * are folded in as zero-length dwells: a click inside an active session
 * REFRESHES its hold (the user is demonstrably still working there), and a
 * lone click still earns a brief zoom — a click is the strongest attention
 * signal there is, even when the cursor never settles for dwellMs.
 */
export function detectZoomRegions(
  track: TrackPoint[],
  opts: Partial<RegionOptions> = {},
  clicks: TrackPoint[] = [],
): ZoomRegion[] {
  const o = { ...DEFAULT_REGION_OPTIONS, ...opts };
  const depth = Math.max(1.05, Math.min(3, o.depth));
  const clusters = detectDwells(track, o);

  // Clicks fold in at the CLUSTER level (adjacent-region merging below could
  // not reach past an unrelated region): a click on/near a recent dwell
  // refreshes that session's hold; only clicks hitting nothing become their
  // own short "click regions".
  const nudgeDist = Math.max(o.radius * 2, 0.15);
  const pending: TrackPoint[] = [...clicks].sort((a, b) => a.tMs - b.tMs);
  const consumed = new Set<TrackPoint>();
  for (const c of clusters) {
    for (const k of pending) {
      if (consumed.has(k)) continue;
      const near = Math.hypot(k.x - c.cx, k.y - c.cy) <= nudgeDist;
      const timely = k.tMs >= c.startMs - o.mergeGapMs && k.tMs <= c.endMs + o.mergeGapMs;
      if (near && timely) {
        c.endMs = Math.max(c.endMs, k.tMs); // the region adds holdMs on top
        consumed.add(k);
      }
    }
  }
  for (const k of pending) {
    if (!consumed.has(k)) {
      clusters.push({ cx: k.x, cy: k.y, startMs: k.tMs, endMs: k.tMs, samples: 2 });
    }
  }
  clusters.sort((a, b) => a.startMs - b.startMs);
  if (clusters.length === 0) return [];

  // Clusters → regions with lead-in and hold.
  const regions: ZoomRegion[] = clusters.map((c) => ({
    startMs: Math.max(0, c.startMs - o.leadInMs),
    endMs: c.endMs + o.holdMs,
    depth,
    cx: c.cx,
    cy: c.cy,
  }));

  // Merge regions whose gap is small AND whose focus is essentially the same
  // spot (the cursor nudged during one working session). Distant dwells stay
  // separate — a zoom to the screen edge must not swallow a later center
  // dwell, and vice versa. Drift cap: once a merged session's focus points
  // span more than `driftSplit`, further merges stop — the camera should
  // GLIDE after slow drift instead of freezing at an averaged midpoint.
  const maxMergeDist = Math.max(o.radius * 2, 0.15);
  const merged: { r: ZoomRegion; fx: number; fy: number }[] = [];
  for (const r of regions) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const dist = Math.hypot(r.cx - prev.r.cx, r.cy - prev.r.cy);
      const drift = Math.hypot(r.cx - prev.fx, r.cy - prev.fy);
      if (r.startMs - prev.r.endMs <= o.mergeGapMs && dist <= maxMergeDist && drift <= o.driftSplit) {
        prev.r.endMs = Math.max(prev.r.endMs, r.endMs);
        prev.r.cx = (prev.r.cx + r.cx) / 2;
        prev.r.cy = (prev.r.cy + r.cy) / 2;
        continue;
      }
    }
    merged.push({ r: { ...r }, fx: r.cx, fy: r.cy });
  }

  // De-overlap and drop short regions.
  const out: ZoomRegion[] = [];
  for (const m of merged) {
    const r = m.r;
    if (out.length) {
      const prev = out[out.length - 1];
      if (r.startMs < prev.endMs) r.startMs = prev.endMs;
    }
    if (r.endMs - r.startMs >= o.minRegionMs) out.push(r);
  }

  // Keep the LONGEST dwells when the mouse sprayed more micro-regions than
  // the render budget allows (chronological order preserved).
  let keep = out;
  if (out.length > o.maxRegions) {
    const ids = new Set(
      [...out]
        .sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs))
        .slice(0, o.maxRegions),
    );
    keep = out.filter((r) => ids.has(r));
  }

  // Focus safety margin: the camera center must keep the working point at
  // least `focusMargin` (fraction of the viewport) inside the frame. The
  // feasible center range around the focus intersects the no-black-edge
  // range [half, 1-half]; when the focus is extreme they may not intersect —
  // then no-black-edge wins (the subject hugs the border, never leaves).
  const mv = Math.min(0.45, Math.max(0, o.focusMargin));
  return keep.map((r) => {
    const half = 0.5 / r.depth;
    const slack = Math.max(0, half - mv / r.depth);
    const clampAxis = (focus: number): number => {
      const lo = Math.max(half, focus - slack);
      const hi = Math.min(1 - half, focus + slack);
      if (lo <= hi) return Math.max(lo, Math.min(hi, focus));
      return Math.max(half, Math.min(1 - half, focus));
    };
    return { ...r, cx: clampAxis(r.cx), cy: clampAxis(r.cy) };
  });
}

export interface FocusSpan {
  startMs: number;
  endMs: number;
  /** 1 = full frame; >1 = zoomed. */
  depth: number;
  /** Focus (only meaningful when depth > 1). */
  cx: number;
  cy: number;
}

/**
 * Expand regions into a complete, non-overlapping render plan covering
 * [0, durationMs] with Recordly timing:
 *  - zoom-in easing (~1.5s) overlaps the START of the region (starts before
 *    the region's first activity, so the zoom reads as anticipatory);
 *  - the zoomed state HOLDS for the whole region — the camera never drifts
 *    while the presenter works there;
 *  - zoom-out easing (~1s) happens AFTER the region ends;
 *  - when the next region starts within CONNECTED_ZOOM_GAP_MS, the camera
 *    glides directly from the old focus to the new one (connected zoom) and
 *    never collapses to full frame.
 * Eases are rendered as smooth ramps; holds are static.
 */
export function buildFocusSpans(
  regions: ZoomRegion[],
  durationMs: number,
  transitionMs = ZOOM_IN_MS,
): FocusSpan[] {
  const spans: FocusSpan[] = [];
  let cursor = 0;

  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const next = regions[i + 1] ?? null;
    const regionEnd = Math.min(r.endMs, durationMs);
    if (regionEnd <= cursor) continue;

    const gapToNext = next ? next.startMs - regionEnd : Infinity;
    const connected = next && gapToNext <= CONNECTED_ZOOM_GAP_MS;

    // Full frame until the zoom-in starts (anticipating the region).
    const zoomInStart = Math.max(cursor, r.startMs - transitionMs);
    if (zoomInStart > cursor) {
      spans.push({ startMs: cursor, endMs: zoomInStart, depth: 1, cx: 0.5, cy: 0.5 });
    }

    // Zoom-in ease: full frame -> region focus/depth.
    const inEnd = Math.min(regionEnd, zoomInStart + transitionMs);
    if (inEnd > zoomInStart) {
      spans.push({ startMs: zoomInStart, endMs: inEnd, depth: r.depth, cx: r.cx, cy: r.cy });
    }

    // HOLD: static zoomed camera for the whole region body. With a connected
    // next region, hold until the glide start; otherwise hold to region end.
    const holdEnd = connected && next
      ? Math.max(inEnd, Math.min(regionEnd, next.startMs - CONNECTED_ZOOM_MS))
      : regionEnd;
    if (holdEnd > inEnd) {
      spans.push({ startMs: inEnd, endMs: holdEnd, depth: r.depth, cx: r.cx, cy: r.cy });
    }

    if (connected && next) {
      // Glide: camera pans/zooms straight to the next focus (no full-frame).
      const glideEnd = Math.min(next.startMs + CONNECTED_ZOOM_MS, durationMs);
      if (glideEnd > holdEnd) {
        spans.push({ startMs: holdEnd, endMs: glideEnd, depth: next.depth, cx: next.cx, cy: next.cy });
      }
      cursor = Math.max(holdEnd, glideEnd);
      // Skip the next region's own lead-in/zoom-in: already arrived via glide.
      const nextInEnd = Math.min(next.endMs, Math.max(cursor, next.startMs + CONNECTED_ZOOM_MS));
      if (nextInEnd > cursor) {
        spans.push({ startMs: cursor, endMs: nextInEnd, depth: next.depth, cx: next.cx, cy: next.cy });
        cursor = nextInEnd;
      }
      // Hold for the next region body happens on its own iteration; align.
      continue;
    }

    // Zoom-out ease: back to full frame AFTER the region ends.
    const outEnd = Math.min(durationMs, regionEnd + ZOOM_OUT_MS);
    if (outEnd > holdEnd) {
      spans.push({ startMs: holdEnd, endMs: outEnd, depth: 1, cx: r.cx, cy: r.cy });
    }
    cursor = outEnd;
  }

  if (cursor < durationMs) {
    spans.push({ startMs: cursor, endMs: durationMs, depth: 1, cx: 0.5, cy: 0.5 });
  }
  return spans.filter((s) => s.endMs > s.startMs);
}
