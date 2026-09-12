/**
 * Capture-source geometry helpers. The privacy overlay draws boxes in
 * PRIMARY-SCREEN normalized coordinates (the overlay covers the primary
 * display), but mask regions must be stored normalized to the CAPTURED
 * FRAME (which may be another monitor or a window). These pure functions
 * do that mapping.
 */

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Map a rect normalized to the PRIMARY SCREEN into a rect normalized to the
 * captured source whose on-screen DIP rect is `sourceRect` (primary-origin).
 * Returns null when the intersection is too small to be meaningful (the box
 * is on another monitor or outside the window) — the caller should refuse
 * privacy masking in that case.
 */
export function mapScreenRectToSource(
  rect: NormRect,
  sourceRect: DipRect,
  screenW: number,
  screenH: number,
): NormRect | null {
  const sw = Math.max(1, screenW);
  const sh = Math.max(1, screenH);
  const src: DipRect = { x: sourceRect.x, y: sourceRect.y, w: Math.max(1, sourceRect.w), h: Math.max(1, sourceRect.h) };

  const ix0 = Math.max(src.x, 0);
  const iy0 = Math.max(src.y, 0);
  const ix1 = Math.min(src.x + src.w, sw);
  const iy1 = Math.min(src.y + src.h, sh);
  const iw = ix1 - ix0;
  const ih = iy1 - iy0;
  if (iw <= 0 || ih <= 0) return null;

  // Box in DIP screen coords.
  const bx0 = rect.x * sw;
  const by0 = rect.y * sh;
  const bx1 = (rect.x + rect.w) * sw;
  const by1 = (rect.y + rect.h) * sh;

  // Intersect with the source rect.
  const cx0 = Math.max(bx0, src.x);
  const cy0 = Math.max(by0, src.y);
  const cx1 = Math.min(bx1, src.x + src.w);
  const cy1 = Math.min(by1, src.y + src.h);
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;
  if (cw <= 4 || ch <= 4) return null;

  // If a meaningful part of the box lies OUTSIDE the source, the mapping is
  // unusable (box spans monitors or hangs out of the window).
  const boxArea = Math.max(1, (bx1 - bx0) * (by1 - by0));
  if ((cw * ch) / boxArea < 0.6) return null;

  return {
    x: (cx0 - src.x) / src.w,
    y: (cy0 - src.y) / src.h,
    w: cw / src.w,
    h: ch / src.h,
  };
}

/** True when a source id refers to a window capture ("window:<hwnd>:<n>"). */
export function isWindowSource(sourceId: string): boolean {
  return /^window:\d+/.test(sourceId || "");
}

/**
 * Privacy-mask variant: instead of rejecting a box that only PARTLY falls in
 * the captured source, clamp it into the source rect (shrink-to-fit) so the
 * mosaic hugs whatever is capturable. Null only when there is no overlap at
 * all (the box is on another display / fully outside the window) — callers
 * should refuse masking in that case with clear feedback.
 */
export function clampScreenRectToSource(
  rect: NormRect,
  sourceRect: DipRect,
  screenW: number,
  screenH: number,
): NormRect | null {
  const sw = Math.max(1, screenW);
  const sh = Math.max(1, screenH);
  const src: DipRect = { x: sourceRect.x, y: sourceRect.y, w: Math.max(1, sourceRect.w), h: Math.max(1, sourceRect.h) };
  const bx0 = rect.x * sw;
  const by0 = rect.y * sh;
  const bx1 = (rect.x + rect.w) * sw;
  const by1 = (rect.y + rect.h) * sh;
  const cx0 = Math.max(bx0, src.x);
  const cy0 = Math.max(by0, src.y);
  const cx1 = Math.min(bx1, src.x + src.w);
  const cy1 = Math.min(by1, src.y + src.h);
  if (cx1 - cx0 < 1 || cy1 - cy0 < 1) return null;
  return {
    x: (cx0 - src.x) / src.w,
    y: (cy0 - src.y) / src.h,
    w: (cx1 - cx0) / src.w,
    h: (cy1 - cy0) / src.h,
  };
}

/** Extract the Win32 HWND from a desktopCapturer window source id. */
export function hwndFromSourceId(sourceId: string): number | null {
  const m = (sourceId || "").match(/^window:(\d+):/);
  return m ? Number(m[1]) : null;
}
