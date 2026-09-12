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
};

interface Cluster {
  cx: number;
  cy: number;
  startMs: number;
  endMs: number;
  samples: number;
}

/** Anchor-based dwell clusters: a cluster is anchored at its first sample;
 *  samples within `radius` of the ANCHOR extend it, anything else breaks it.
 *  (A running centroid would rubber-band across minutes of slow wandering and
 *  glue unrelated activity into one giant "dwell".) */
export function detectDwells(
  track: TrackPoint[],
  opts: Pick<RegionOptions, "dwellMs" | "radius">,
): Cluster[] {
  const clusters: Cluster[] = [];
  if (track.length === 0) return clusters;
  const radius = Math.max(0.01, opts.radius);

  let cur: Cluster | null = null;
  const flush = () => {
    if (cur && cur.endMs - cur.startMs >= opts.dwellMs && cur.samples >= 2) {
      clusters.push(cur);
    }
    cur = null;
  };

  for (const p of track) {
    if (!cur) {
      cur = { cx: p.x, cy: p.y, startMs: p.tMs, endMs: p.tMs, samples: 1 };
      continue;
    }
    const dist = Math.hypot(p.x - cur.cx, p.y - cur.cy);
    if (dist <= radius) {
      // Running centroid within the anchored radius.
      cur.cx = (cur.cx * cur.samples + p.x) / (cur.samples + 1);
      cur.cy = (cur.cy * cur.samples + p.y) / (cur.samples + 1);
      cur.samples++;
      cur.endMs = p.tMs;
    } else {
      flush();
      cur = { cx: p.x, cy: p.y, startMs: p.tMs, endMs: p.tMs, samples: 1 };
    }
  }
  flush();
  return clusters;
}

/**
 * Detect zoom regions: dwell clusters become regions with lead-in/hold and
 * depth; nearby regions merge; overlapping regions are clipped.
 */
export function detectZoomRegions(
  track: TrackPoint[],
  opts: Partial<RegionOptions> = {},
): ZoomRegion[] {
  const o = { ...DEFAULT_REGION_OPTIONS, ...opts };
  const depth = Math.max(1.05, Math.min(3, o.depth));
  const clusters = detectDwells(track, o);
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
  // dwell, and vice versa.
  const maxMergeDist = Math.max(o.radius * 2, 0.15);
  const merged: ZoomRegion[] = [];
  for (const r of regions) {
    const prev = merged[merged.length - 1];
    const dist = prev ? Math.hypot(r.cx - prev.cx, r.cy - prev.cy) : Infinity;
    if (prev && r.startMs - prev.endMs <= o.mergeGapMs && dist <= maxMergeDist) {
      prev.endMs = Math.max(prev.endMs, r.endMs);
      prev.cx = (prev.cx + r.cx) / 2;
      prev.cy = (prev.cy + r.cy) / 2;
      continue;
    }
    merged.push({ ...r });
  }

  // De-overlap and drop short regions.
  const out: ZoomRegion[] = [];
  for (const r of merged) {
    if (out.length) {
      const prev = out[out.length - 1];
      if (r.startMs < prev.endMs) r.startMs = prev.endMs;
    }
    if (r.endMs - r.startMs >= o.minRegionMs) out.push(r);
  }
  return out;
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
