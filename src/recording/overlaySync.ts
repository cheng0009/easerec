/**
 * Desktop overlay sync — mirrors the annotation effects (magnifier lens, step
 * markers, highlighter ring) into the always-on-top transparent overlay window
 * in the main process. The overlay floats over the real desktop, so the user
 * sees the effects live while presenting.
 *
 * Magnifier: the lens PIXELS are sampled live from the captured screen stream
 * at the cursor position. The glass is drawn a fixed distance away from the
 * cursor (towards the roomiest screen corner) so the glass NEVER overlaps its
 * own sampled source circle — otherwise the captured stream (which includes the
 * overlay artwork on this machine) would re-capture the lens image forever
 * (hall-of-mirrors). A source "spotlight" ring marks the sampled area.
 *
 * Coordinates are kept in display-DIP space (matching the overlay window size):
 * markers / cursor are normalized 0..1 of the primary display DIP size, and the
 * lens crop is converted into captured-stream pixels via the DIP->pixel scale
 * so it stays correct on scaled displays.
 *
 * Recording: while the overlay is active it is captured with the screen (the
 * annotation source), so Recorder.compose() keeps the canvas neutral (the
 * overlay is NOT re-drawn there).
 */

import { getDirector } from "./director";
import { useStore } from "../store";
import { listenEvent } from "../lib/tauri";

const g = globalThis as unknown as {
  __directorcam?: {
    send: (channel: string, payload?: unknown) => void;
  };
};

/** Glass radius BASE as a fraction of the smaller screen dimension (level 1). */
const LENS_FRAC = 0.16;
/** Extra glass-radius fraction per zoom level, so the lens hole grows with the
 *  magnification ladder (levels 1/2/3 → 0.16 / 0.26 / 0.36 of min dimension). */
const LENS_R_STEP = 0.10;
/** Base magnification of the lens circle over the surrounding content. */
const LENS_MAG_BASE = 2.0;
/** How often the lens PIXELS are re-sampled (ms). The lens POSITION still
 *  tracks the cursor live; this cadence keeps the sampled region fresh without
 *  over-feeding the stream. */
const LENS_REFRESH_MS = 80;

/** Desktop-dimming alpha applied by overlay.html (kept in sync so the lens
 *  crop can be scaled back up to true brightness after sampling the dimmed
 *  captured stream). */
const LENS_DIM_ALPHA = 0.42;

/** Magnifier zoom levels (digits 1/2/3 while the magnifier is active): each
 *  level magnifies the previous one by +50% so the ladder is unmistakable
 *  (2.0 / 3.0 / 4.5). */
function lensMagFor(level: number): number {
  const lv = Number.isFinite(level) ? level : 2;
  return LENS_MAG_BASE * Math.pow(1.5, Math.min(3, Math.max(1, lv)) - 1);
}

let running = false;
let lastPush = 0;
let lastLensAt = 0;
let lastLens: { w: number; h: number; data: Uint8ClampedArray } | null = null;
let lensCanvas: HTMLCanvasElement | null = null;

// Magnifier glass anchor: latched corner with hysteresis + a subtle glide on a
// real corner switch. Re-picking the "roomiest corner" every frame makes the
// lens flap left/right when two corners are near-tied (middle bands, or both
// borders clamping together) — latching stops the ping-pong; the glide stops
// the teleport when the cursor genuinely crosses into a new corner's territory.
let glassCorner = -1;
let glassPos: { x: number; y: number } | null = null;

// Highlighter pen: press-to-draw, release-to-lift. Points stream to the
// overlay window as tiny incremental events the moment they are sampled (not
// batched into the 33ms frame push), and the overlay draws the live segment
// from the last point to the cursor on every 60Hz cursor update — so the
// trail tracks the mouse with no perceptible lag while the button is held.
// Each press-drag-release is its OWN stroke; new strokes never connect to
// earlier ink. Per-point color = strong contrast complement of the desktop
// pixel under the pen.
interface PenPoint { x: number; y: number; color: string; }
type PenEvent =
  | { t: "down"; x: number; y: number; color: string }
  | { t: "pt"; x: number; y: number; color: string }
  | { t: "up" }
  | { t: "clear" }
  | { t: "trim" };
let penDown = false;
let penEverDrew = false;
let penCurrent: PenPoint[] | null = null;
let penLast: PenPoint | null = null;
let penPixelCanvas: HTMLCanvasElement | null = null;

/** Fire-and-forget incremental pen event straight to the overlay window. */
function sendPen(ev: PenEvent): void {
  g.__directorcam?.send("dc-overlay-send", { penEvent: ev });
}

// Ripple: expanding rings spawned on each physical left-click while the
// "ripple" mode is on. Each ripple carries the strong-contrast color of the
// desktop region it was spawned on. overlay.html animates them by start time.
// The previous toggle state lets tick() spawn a confirmation ripple when the
// mode is switched ON via Alt+R, so the user sees it activate.
interface RippleEvent {
  x: number;
  y: number;
  start: number;
  color: { h: number; s: number; l: number } | null;
}
let ripples: RippleEvent[] = [];
let prevRippleEnabled = false;

/** Ripple at a screen-DIP position whose color contrasts its background. */
function rippleAt(x: number, y: number): RippleEvent {
  const px = samplePixelColor(x, y);
  return { x, y, start: Date.now(), color: px ? contrastHsl(px.r, px.g, px.b) : null };
}

function send(payload: unknown): void {
  g.__directorcam?.send("dc-overlay-send", payload);
}
function clear(): void {
  g.__directorcam?.send("dc-overlay-clear", null);
}

// Click shield: while effects are on the overlay intercepts clicks so drawing
// never operates the windows below. Sent to main only on state changes.
let shieldOn = false;
function setShield(on: boolean): void {
  if (on === shieldOn) return;
  shieldOn = on;
  g.__directorcam?.send("dc-overlay-shield", on);
}

function screenDips(): { w: number; h: number } {
  return {
    w: Math.max(1, window.screen?.width || 1920),
    h: Math.max(1, window.screen?.height || 1080),
  };
}

function sourceSize(): { w: number; h: number } | null {
  try {
    const r = getDirector().recorder as unknown as {
      sourceSizePublic?: { width: number; height: number };
    };
    if (r.sourceSizePublic) return { w: r.sourceSizePublic.width, h: r.sourceSizePublic.height };
  } catch { /* ignore */ }
  return null;
}

function cursorScreen(): { x: number; y: number } {
  try {
    const r = getDirector().recorder as unknown as {
      cursorScreenPublic?: { x: number; y: number };
    };
    if (r.cursorScreenPublic) return r.cursorScreenPublic;
  } catch { /* ignore */ }
  return { x: 0, y: 0 };
}

/** Magnified source crop centered under the cursor, sampled LIVE from the
 *  captured screen stream (plain desktop here, not the overlay's artwork). */
function buildLensCrop(mag: number, R: number): { w: number; h: number; data: Uint8ClampedArray } | null {
  const rec = getDirector().recorder as unknown as {
    screenVideoPublic?: HTMLVideoElement | null;
  };
  const video = rec.screenVideoPublic;
  const srcSize = sourceSize();
  if (!video || !srcSize) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const disp = screenDips();
  const curDip = cursorScreen();

  // Cursor (primary-display DIP) -> captured-stream pixels.
  const sppx = srcSize.w / disp.w;
  const cxSrc = Math.max(0, Math.min(vw - 1, curDip.x * sppx));
  const cySrc = Math.max(0, Math.min(vh - 1, curDip.y * (srcSize.h / disp.h)));

  // Square source-region that, drawn across the lens diameter, reads ~mag.
  const halfSrc = (R / mag) * sppx;
  const side = Math.max(2, Math.round(halfSrc * 2));
  if (side >= vw || side >= vh) return null;

  let x0 = Math.min(Math.max(0, Math.round(cxSrc - halfSrc)), Math.max(0, vw - side));
  let y0 = Math.min(Math.max(0, Math.round(cySrc - halfSrc)), Math.max(0, vh - side));
  if (x0 + side > vw) x0 = Math.max(0, vw - side);
  if (y0 + side > vh) y0 = Math.max(0, vh - side);

  const tmp = lensCanvas ?? (lensCanvas = document.createElement("canvas"));
  if (tmp.width !== side) tmp.width = side;
  if (tmp.height !== side) tmp.height = side;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  if (!tctx) return null;
  try {
    tctx.drawImage(video, x0, y0, side, side, 0, 0, side, side);
    const img = tctx.getImageData(0, 0, side, side);
    // The captured stream already contains the overlay's 42% dim (recording
    // captures the overlay itself), so scale the crop back up so the lens
    // reads at the true desktop brightness. Uint8ClampedArray clamps on write.
    if (LENS_DIM_ALPHA > 0) {
      const k = 1 / (1 - LENS_DIM_ALPHA);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = d[i] * k;
        d[i + 1] = d[i + 1] * k;
        d[i + 2] = d[i + 2] * k;
      }
    }
    return { w: side, h: side, data: img.data };
  } catch {
    return null;
  }
}

/** Sample the desktop pixel under the pen from the captured stream. */
function samplePixelColor(dipX: number, dipY: number): { r: number; g: number; b: number } | null {
  const rec = getDirector().recorder as unknown as {
    screenVideoPublic?: HTMLVideoElement | null;
  };
  const video = rec.screenVideoPublic;
  const srcSize = sourceSize();
  if (!video || !srcSize || !video.videoWidth) return null;
  const disp = screenDips();
  const cx = Math.max(0, Math.min(video.videoWidth - 1, Math.round(dipX * (srcSize.w / disp.w))));
  const cy = Math.max(0, Math.min(video.videoHeight - 1, Math.round(dipY * (srcSize.h / disp.h))));
  const tmp = penPixelCanvas ?? (penPixelCanvas = document.createElement("canvas"));
  if (tmp.width !== 1) { tmp.width = 1; tmp.height = 1; }
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  if (!tctx) return null;
  try {
    tctx.drawImage(video, cx, cy, 1, 1, 0, 0, 1, 1);
    const d = tctx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2] };
  } catch {
    return null;
  }
}

/** Strong-contrast color components: complementary hue + flipped lightness.
 *  Hue is quantized to 30° so stable backgrounds yield long color-consistent
 *  runs. Returns structured {h,s,l} so ripple animation can build hsla() at
 *  varying alphas. */
function contrastHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0));
    else if (max === gn) h = ((bn - rn) / d + 2);
    else h = ((rn - gn) / d + 4);
    h *= 60;
  }
  const newH = Math.round(((h + 180) % 360) / 30) * 30;
  // Vivid, never gray: the complement's lightness is pulled toward the middle
  // of its range (dark bg → a rich light color ~0.62, bright bg → a deep dark
  // color ~0.18) instead of the pale 0.9 which reads as gray-white on dark
  // interfaces. Saturation is clamped near-full.
  const newL = l >= 0.45 ? 0.18 : 0.62;
  const newS = Math.max(s, 0.9);
  return { h: newH, s: newS, l: newL };
}

function contrastCss(r: number, g: number, b: number): string {
  const c = contrastHsl(r, g, b);
  return `hsl(${c.h},${Math.round(c.s * 100)}%,${Math.round(c.l * 100)}%)`;
}

/** Live pen color = contrast complement of the desktop pixel under the pen. */
function penColorAt(dipX: number, dipY: number): string {
  const px = samplePixelColor(dipX, dipY);
  if (!px) return "rgba(255,210,40,0.95)";
  return contrastCss(px.r, px.g, px.b);
}

/** Append a pen point (throttled) to the CURRENT stroke. The stroke keeps ONE
 *  fixed color — the contrast complement sampled at the PRESS position — so
 *  the line never rainbow-shifts as it crosses different desktop pixels. */
const penPointCount = { n: 0 };
let penStrokeColor: string | null = null;
function appendPenPoint(x: number, y: number): void {
  if (x < 0 || y < 0) return;
  if (!penCurrent) return;
  if (penLast && Math.abs(x - penLast.x) < 2 && Math.abs(y - penLast.y) < 2) return;
  const color = penStrokeColor || penColorAt(x, y);
  penLast = { x, y, color };
  penCurrent.push(penLast);
  penEverDrew = true;
  penPointCount.n++;
  if (penPointCount.n > 6000) {
    // Cap total ink; tell the overlay to drop the oldest stroke with us.
    penPointCount.n -= 2000;
    sendPen({ t: "trim" });
  }
  sendPen({ t: "pt", x, y, color });
}

/** Begin a fresh independent stroke at the press point. */
function startPenStroke(x: number, y: number): void {
  penDown = true;
  penLast = null;
  penCurrent = [];
  // Fixed color for the WHOLE stroke (sampled once, at the press point).
  penStrokeColor = penColorAt(x, y);
  const color = penStrokeColor;
  const first: PenPoint = { x, y, color };
  penLast = first;
  penCurrent.push(first);
  penEverDrew = true;
  sendPen({ t: "down", x, y, color });
}

/** Release: the overlay keeps the ink; the next press continues the line. */
function endPenStroke(): void {
  if (penDown) sendPen({ t: "up" });
  penDown = false;
  penCurrent = null;
  penLast = null;
}

/** Glass centre = cursor pushed a fixed safe distance toward the roomiest
 *  screen corner, so the glass never sits on top of its own source circle.
 *
 *  Stability: the chosen corner is LATCHED (hysteresis) — it only moves to a
 *  different corner when that corner has clearly more room — so near-tied
 *  corners never flip the lens left/right frame to frame. On a genuine switch
 *  the glass glides from its old spot instead of teleporting. */
function glassAnchor(
  cur: { x: number; y: number },
  R: number,
  Rs: number,
  disp: { w: number; h: number },
): { x: number; y: number } {
  const desired = R + Rs + 24;
  const corners = [
    { x: 0, y: 0 }, { x: disp.w, y: 0 }, { x: 0, y: disp.h }, { x: disp.w, y: disp.h },
  ];
  const cands: { t: number; x: number; y: number }[] = [];
  let best = -1;
  let bestDist = -1;
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    const dx = c.x - cur.x;
    const dy = c.y - cur.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len;
    const uy = dy / len;
    // Max travel before the glass edge (R) hits the screen border.
    let maxT = Infinity;
    if (ux > 0) maxT = Math.min(maxT, (disp.w - R - cur.x) / ux);
    else if (ux < 0) maxT = Math.min(maxT, (cur.x - R) / -ux);
    if (uy > 0) maxT = Math.min(maxT, (disp.h - R - cur.y) / uy);
    else if (uy < 0) maxT = Math.min(maxT, (cur.y - R) / -uy);
    const t = Math.min(desired, Math.max(0, maxT));
    cands.push({ t, x: cur.x + ux * t, y: cur.y + uy * t });
    if (t > bestDist) { bestDist = t; best = i; }
  }

  let idx: number;
  if (glassCorner < 0 || glassCorner >= corners.length) {
    idx = best;
  } else {
    const prev = cands[glassCorner];
    const clearWin = cands[best].t - prev.t > Math.max(20, desired * 0.12);
    idx = best === glassCorner ? best : (clearWin ? best : glassCorner);
  }
  const switched = idx !== glassCorner;
  glassCorner = idx;

  const target = cands[idx];
  if (!glassPos) {
    glassPos = { x: target.x, y: target.y };
  } else if (switched) {
    // Corner change: glide smoothly across instead of a jarring teleport.
    glassPos.x += (target.x - glassPos.x) * 0.45;
    glassPos.y += (target.y - glassPos.y) * 0.45;
  } else {
    glassPos.x = target.x;
    glassPos.y = target.y;
  }
  return { ...glassPos };
}

function tick(): void {
  const now = Date.now();
  if (now - lastPush < 33) return; // ~30fps max
  lastPush = now;

  const eff = useStore.getState().effects;
  const rec = getDirector().recorder as unknown as {
    setDesktopOverlayActive?: (v: boolean) => void;
  };

  const countdown =
    typeof eff.countdown === "number" && Number.isFinite(eff.countdown)
      ? Math.max(0, Math.min(9, Math.round(eff.countdown)))
      : null;

  // Privacy masking is overlay-resident too: while a mask is LIVE (box drawing,
  // or an active mask between the two F6 presses) the overlay window must keep
  // showing — otherwise the page's 33ms effect-clear would hide the window and
  // the persistent mosaic would flash once and vanish (the "box doesn't hold"
  // bug). The mosaic + "遮挡中" pill are drawn overlay-side from privacyBoxes.
  const marks = useStore.getState().marks;
  const privacyActive = marks.activePrivacy != null || marks.privacyDrawing;

  const anyActive =
    eff.activeMagnifier || eff.activeHighlighter || eff.stepMarkers.length > 0 ||
    eff.rippleEnabled || countdown != null || privacyActive;

  // Clicks pass through while ONLY ripple mode is active: the user needs to
  // keep operating the window below (the ripple is drawn from the global input
  // hook, so it still appears). Only drawing/annotation modes block clicks.
  const blocking =
    eff.activeMagnifier || eff.activeHighlighter || eff.stepMarkers.length > 0;

  // While effects are shown on the real desktop they are captured with the
  // screen; the recording canvas stays a neutral full-frame copy so the
  // recorded video matches the overlay's screen-space positions exactly once.
  if (typeof rec.setDesktopOverlayActive === "function") {
    rec.setDesktopOverlayActive(anyActive);
  }

  // Prune ripples older than the overlay's animation window (900ms).
  while (ripples.length && Date.now() - ripples[0].start > 900) ripples.shift();

  if (!anyActive) {
    lastLens = null;
    if (penDown || penEverDrew) sendPen({ t: "clear" });
    penDown = false;
    penCurrent = null;
    penLast = null;
    penEverDrew = false;
    penPointCount.n = 0;
    ripples = [];
    prevRippleEnabled = false;
    setShield(false);
    clear();
    return;
  }
  setShield(blocking);

  // Highlighter mode turned off mid-flight: clear the overlay-side ink too.
  if (!eff.activeHighlighter && (penDown || penEverDrew)) {
    sendPen({ t: "clear" });
    penDown = false;
    penCurrent = null;
    penLast = null;
    penEverDrew = false;
    penPointCount.n = 0;
  }

  const disp = screenDips();
  const mag = lensMagFor(eff.lensLevel);
  const lv = Math.min(3, Math.max(1, Number.isFinite(eff.lensLevel) ? eff.lensLevel : 2));
  const R = (LENS_FRAC + (lv - 1) * LENS_R_STEP) * Math.min(disp.w, disp.h);
  const Rs = R / mag;
  const cur = cursorScreen();

  // Ripple toggled ON (Alt+R): spawn a ripple at the current cursor as instant
  // visual confirmation that the mode is now active.
  if (eff.rippleEnabled && !prevRippleEnabled) {
    ripples.push(rippleAt(cur.x, cur.y));
    if (ripples.length > 40) ripples.splice(0, ripples.length - 40);
  }
  prevRippleEnabled = eff.rippleEnabled;

  let lens: { w: number; h: number; data: Uint8ClampedArray } | null = null;
  if (eff.activeMagnifier) {
    if (now - lastLensAt >= LENS_REFRESH_MS) {
      lastLens = buildLensCrop(mag, R);
      lastLensAt = now;
    }
    lens = lastLens;
  } else {
    lastLens = null;
    glassCorner = -1;
    glassPos = null;
  }

  const glass = eff.activeMagnifier ? glassAnchor(cur, R, Rs, disp) : null;

  send({
    magnifier: eff.activeMagnifier
      ? {
          x: cur.x,
          y: cur.y,
          R,
          Rs,
          gx: glass?.x,
          gy: glass?.y,
          image: lens,
        }
      : null,
    highlighter: eff.activeHighlighter
      ? { penDown, level: eff.penLevel ?? 1 } // strokes stream via ov-pen
      : null,
    markers: eff.stepMarkers.map((m) => ({
      x: m.x,
      y: m.y,
      color: eff.stepMarkerColor ?? "blue",
    })),
    ripples: ripples.map((r) => ({ x: r.x, y: r.y, start: r.start, color: r.color })),
    countdown,
    cursor: { x: cur.x, y: cur.y },
  });
}

export function startOverlaySync(): void {
  if (running) return;
  running = true;
  setInterval(tick, 33);

  // Native pen input (push from main's low-level mouse hook): draw while LMB
  // is held, colored by the desktop pixel under the pen, in real time. Each
  // press starts a fresh independent stroke; release ends it.
  void listenEvent<{ x: number; y: number }>("dc-mouse-down", (p) => {
    if (!p || typeof p.x !== "number") return;
    if (!useStore.getState().effects.activeHighlighter) return;
    startPenStroke(p.x, p.y);
  }).catch(() => {});
  void listenEvent<{ x: number; y: number }>("dc-mouse-up", () => {
    endPenStroke();
  }).catch(() => {});
  void listenEvent<{ x: number; y: number }>("dc-cursor", (p) => {
    if (p && typeof p.x === "number") {
      if (useStore.getState().effects.activeHighlighter && penDown) {
        appendPenPoint(p.x, p.y);
      }
    }
  }).catch(() => {});

  // Ripple ring on each physical left-click while the ripple mode is on.
  void listenEvent<{ x: number; y: number }>("dc-mouse-click", (p) => {
    if (!p || typeof p.x !== "number") return;
    if (!useStore.getState().effects.rippleEnabled) return;
    ripples.push(rippleAt(p.x, p.y));
    if (ripples.length > 40) ripples.splice(0, ripples.length - 40);
  }).catch(() => {});
}

export function stopOverlaySync(): void {
  running = false;
}