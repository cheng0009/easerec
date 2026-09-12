/**
 * SmartZoom — "smart follow" camera controller.
 *
 * Two-layer model, ported from Recordly's cursor-follow camera
 * (AGPL-3.0, https://github.com/webadderall/Recordly — src/components/
 * video-editor/videoPlayback/cursorFollowCamera.ts):
 *
 * 1. Central stop circle — while the cursor stays inside a *circular* region at
 *    the center of the frame (radius measured in screen pixels, so it looks like
 *    a true circle regardless of aspect ratio) the camera holds screen center
 *    and stays at fit (scale 1). The moment the cursor leaves the circle the
 *    camera eases in a zoom and starts panning.
 *
 * 2. Safe-zone follow — once zoomed, the camera keeps a persistent focus and
 *    only recenters after the cursor leaves an inner safe zone *within the
 *    current zoomed view* (scaled by zoom, Recordly's snapToEdgesRatio). This
 *    prevents constant micro-panning; the spring camera eases every retarget.
 *
 * Anti-shake layers on top:
 *   - Micro-movements (< deadZonePx between samples) keep the previous target.
 *   - Teleport jumps (> teleportPx) are treated as focus hand-off and ignored.
 *
 * The focus is expressed as normalized (0-1) coordinates of the screen source.
 */

export interface SmartZoomConfig {
  enabled: boolean;
  /** Zoom level when smart zoom is active (1.0 = fit). */
  zoomLevel: number;
  /** Radius of the central circular "no-follow" zone (fraction of viewport
   *  WIDTH; applied in pixel space so the boundary is a true circle). */
  centerZone: number;
  /** Hysteresis band (same units as centerZone) to avoid follow/nofollow flip. */
  hysteresis: number;
  /** Movement below this (in pixels of cursor) is treated as static — no (re)target. */
  deadZonePx: number;
  /** Movement above this is treated as a teleport / hand-off and excluded. */
  teleportPx: number;
  /** Frame-coordinate smoothing factor for the raw cursor target (unused now;
   *  the spring camera provides the easing). */
  cursorSmoothing: number;
  /** How much of the zoomed view's edge pins the camera before it recenters
   *  (Recordly's inner safe-zone ratio, 0-0.49). */
  snapToEdgesRatio: number;
}

export interface CursorSample {
  x: number; // screen pixels
  y: number; // screen pixels
}

export interface Viewport {
  width: number;
  height: number;
}

type FollowState = "centered" | "tracking";

const DEFAULTS: SmartZoomConfig = {
  enabled: true,
  zoomLevel: 1.5,
  centerZone: 0.18,
  hysteresis: 0.03,
  deadZonePx: 2.5,
  teleportPx: 900,
  cursorSmoothing: 0.67,
  snapToEdgesRatio: 0.25,
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export class SmartZoom {
  private cfg: SmartZoomConfig;
  private lastSample: CursorSample | null = null;
  private jumpCounter = 0;
  private canTarget = false;
  private state: FollowState = "centered";
  private focus = { x: 0.5, y: 0.5 };
  private currentZoom = 1;
  private currentTarget = { x: 0.5, y: 0.5 };

  constructor(cfg?: Partial<SmartZoomConfig>) {
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  updateConfig(cfg: Partial<SmartZoomConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  get config(): SmartZoomConfig {
    return this.cfg;
  }

  /** True while the follow-camera is actively tracking the cursor (i.e. outside
   *  the central circle). Controls whether the camera is zoomed and panning. */
  get tracking(): boolean {
    return this.cfg.enabled && this.state === "tracking";
  }

  /** Feed the current (eased) zoom back so the safe-zone math matches the view. */
  setCurrentZoom(scale: number): void {
    this.currentZoom = Math.max(1, scale || 1);
  }

  /**
   * Process a new cursor sample, returning the camera's *target* focus
   * (screen center while inside the circle, the Recordly safe-zone follow
   * otherwise), or `null` if the sample should not retarget.
   */
  process(
    sample: CursorSample,
    viewport: Viewport,
  ): { x: number; y: number } | null {
    if (!this.cfg.enabled) return null;

    const prev = this.lastSample;
    this.lastSample = sample;
    const cursor = this.toNormalized(sample, viewport);
    const W = Math.max(1, viewport.width || 1);
    const H = Math.max(1, viewport.height || 1);
    const dUnit = Math.hypot(sample.x - W / 2, sample.y - H / 2) / W;

    if (!prev) {
      this.jumpCounter++;
      if (this.jumpCounter < 3) return null;
      this.canTarget = true;
      return this.resolveTarget(dUnit, cursor);
    }

    const dist = Math.hypot(sample.x - prev.x, sample.y - prev.y);

    // Teleport / hand-off guard: cursor makes an implausibly large jump.
    if (dist > this.cfg.teleportPx) {
      this.canTarget = false;
      this.jumpCounter = 0;
      return null;
    }

    // Anti-shake dead zone: tiny movements keep the previous target.
    if (dist < this.cfg.deadZonePx) {
      return this.canTarget ? this.currentTarget : null;
    }

    this.canTarget = true;
    this.jumpCounter = Math.min(this.jumpCounter + 1, 999999);
    return this.resolveTarget(dUnit, cursor);
  }

  /** State machine: leave the circle → track (Recordly safe-zone follow);
   *  re-enter → ease back to center at fit. */
  private resolveTarget(
    dUnit: number,
    cursor: { x: number; y: number },
  ): { x: number; y: number } {
    const { centerZone, hysteresis } = this.cfg;
    if (this.state === "tracking") {
      if (dUnit < centerZone - hysteresis) this.state = "centered";
    } else if (dUnit > centerZone + hysteresis) {
      this.state = "tracking";
    }

    if (this.state === "centered") {
      this.currentTarget = { x: 0.5, y: 0.5 };
    } else {
      this.focus = this.computeFollowingFocus(cursor);
      this.currentTarget = { x: this.focus.x, y: this.focus.y };
    }
    return this.currentTarget;
  }

  /**
   * Recordly's recenter-when-cursor-leaves-safe-zone: while zoomed the camera
   * holds its focus and only moves once the cursor crosses the inner safe zone
   * of the *current* zoomed view (scaled by zoom).
   */
  private computeFollowingFocus(cursor: { x: number; y: number }): { x: number; y: number } {
    const zoom = Math.max(1, this.currentZoom);
    const halfSpan = 1 / (2 * zoom);
    const inset = halfSpan * 2 * clamp01(this.cfg.snapToEdgesRatio);

    let nx = this.focus.x;
    let ny = this.focus.y;
    if (cursor.x < this.focus.x - halfSpan + inset) nx = cursor.x;
    else if (cursor.x > this.focus.x + halfSpan - inset) nx = cursor.x;
    if (cursor.y < this.focus.y - halfSpan + inset) ny = cursor.y;
    else if (cursor.y > this.focus.y + halfSpan - inset) ny = cursor.y;

    return this.clampFocusToView(nx, ny, halfSpan);
  }

  private clampFocusToView(x: number, y: number, halfSpan: number): { x: number; y: number } {
    return {
      x: Math.max(halfSpan, Math.min(1 - halfSpan, x)),
      y: Math.max(halfSpan, Math.min(1 - halfSpan, y)),
    };
  }

  /** Smooth an incoming raw sample before it reaches the spring (low-pass). */
  smoothTarget(raw: CursorSample, viewport: Viewport): CursorSample {
    const target = this.toNormalized(raw, viewport);
    void target;
    return raw;
  }

  private toNormalized(sample: CursorSample, viewport: Viewport): { x: number; y: number } {
    const nx = viewport.width > 0 ? sample.x / viewport.width : 0.5;
    const ny = viewport.height > 0 ? sample.y / viewport.height : 0.5;
    return { x: clamp01(nx), y: clamp01(ny) };
  }

  reset(): void {
    this.lastSample = null;
    this.jumpCounter = 0;
    this.canTarget = false;
    this.state = "centered";
    this.focus = { x: 0.5, y: 0.5 };
    this.currentZoom = 1;
    this.currentTarget = { x: 0.5, y: 0.5 };
  }
}