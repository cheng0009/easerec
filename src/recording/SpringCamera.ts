/**
 * SpringCamera — analytic damped-harmonic-oscillator "camera" that smoothly
 * chases a target focus point (the mouse cursor) and zoom scale, so pan/zoom
 * motion feels natural, eased and anti-shake.
 *
 * The spring solver (stepSpringValue) is ported from Recordly's motion engine
 * (AGPL-3.0, https://github.com/webadderall/Recordly —
 * src/components/video-editor/videoPlayback/motionSmoothing.ts). It integrates
 * the closed-form solution of a damped oscillator per axis with an overshoot
 * guard for ζ ≥ 1, which gives an eased settle with no jelly wobble:
 *   zoom → barely-overdamped fast/floaty settle (damping ratio ≈ 1.05)
 *   pan  → overdamped glide (damping ratio ≥ 1.3)
 */

export interface CameraSpringState {
  x: number; // current normalized camera center X (0-1)
  y: number; // current normalized camera center Y (0-1)
  vx: number; // velocity X (units/second)
  vy: number; // velocity Y (units/second)
  scale: number; // current zoom scale (1.0 = fit)
  vscale: number; // zoom velocity (units/second)
}

export interface SpringTuning {
  stiffnessMultiplier: number;
  dampingMultiplier: number;
  massMultiplier: number;
}

export interface CameraSpringOptions {
  /** Pan/zoom tunings applied on top of the Recordly base spring configs. */
  tuning: SpringTuning;
  /** Initial scale. */
  startScale: number;
  /** Integration timestep cap to avoid jumps when the tab is inactive. */
  maxDtMs: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clampDeltaMs(deltaMs: number, fallbackMs = 1000 / 60): number {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return fallbackMs;
  return Math.min(80, Math.max(1, deltaMs));
}

interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
  restDelta: number;
  restSpeed: number;
}

interface SpringState {
  value: number;
  velocity: number;
  initialized: boolean;
}

function createSpringState(initialValue = 0): SpringState {
  return { value: initialValue, velocity: 0, initialized: false };
}

function resetSpringState(state: SpringState, initialValue?: number): void {
  if (typeof initialValue === "number") state.value = initialValue;
  state.velocity = 0;
  state.initialized = false;
}

function resolveSpringPosition(
  t: number,
  target: number,
  initialDelta: number,
  initialVelocity: number,
  dampingRatio: number,
  undampedAngularFreq: number,
): number {
  if (dampingRatio < 1) {
    // Underdamped — oscillatory envelope.
    const dampedFreq = undampedAngularFreq * Math.sqrt(1 - dampingRatio * dampingRatio);
    const envelope = Math.exp(-dampingRatio * undampedAngularFreq * t);
    return (
      target -
      envelope *
        (((initialVelocity + dampingRatio * undampedAngularFreq * initialDelta) / dampedFreq) *
          Math.sin(dampedFreq * t) +
          initialDelta * Math.cos(dampedFreq * t))
    );
  }

  if (dampingRatio === 1) {
    // Critically damped — fastest non-oscillating convergence.
    return (
      target -
      Math.exp(-undampedAngularFreq * t) *
        (initialDelta + (initialVelocity + undampedAngularFreq * initialDelta) * t)
    );
  }

  // Overdamped — exponential decay, no oscillation.
  const dampedFreq = undampedAngularFreq * Math.sqrt(dampingRatio * dampingRatio - 1);
  const envelope = Math.exp(-dampingRatio * undampedAngularFreq * t);
  const freqT = Math.min(dampedFreq * t, 300);
  return (
    target -
    (envelope *
      ((initialVelocity + dampingRatio * undampedAngularFreq * initialDelta) * Math.sinh(freqT) +
        dampedFreq * initialDelta * Math.cosh(freqT))) /
      dampedFreq
  );
}

/**
 * Advance a damped harmonic oscillator (Hooke's law F = −kx − cv) one step
 * using the closed-form position solution and a forward-difference velocity.
 */
function stepSpringValue(state: SpringState, target: number, deltaMs: number, config: SpringConfig): number {
  const safeDeltaMs = clampDeltaMs(deltaMs);

  if (!state.initialized || !Number.isFinite(state.value)) {
    state.value = target;
    state.velocity = 0;
    state.initialized = true;
    return state.value;
  }

  const restDelta = config.restDelta ?? 0.0005;
  const restSpeed = config.restSpeed ?? 0.02;

  if (Math.abs(target - state.value) <= restDelta && Math.abs(state.velocity) <= restSpeed) {
    state.value = target;
    state.velocity = 0;
    return state.value;
  }

  const { stiffness, damping, mass } = config;
  const undampedAngularFreq = Math.sqrt(stiffness / mass);
  const dampingRatio = damping / (2 * Math.sqrt(stiffness * mass));
  const initialDelta = target - state.value;
  const initialVelocity = -state.velocity;
  const tSec = safeDeltaMs / 1000;

  const current = resolveSpringPosition(
    tSec,
    target,
    initialDelta,
    initialVelocity,
    dampingRatio,
    undampedAngularFreq,
  );

  // Overshoot guard for overdamped / critically-damped springs (ζ ≥ 1).
  // With a fixed target an overdamped spring never overshoots, but when the
  // target moves every frame carried-over velocity can push the value past the
  // new target → jelly wobble on reversal. Clamping keeps the speed while
  // killing the counter-oscillation.
  if (dampingRatio >= 1) {
    const crossed =
      (state.value <= target && current > target) ||
      (state.value >= target && current < target);
    if (crossed) {
      state.value = target;
      state.velocity = 0;
      return state.value;
    }
  }

  const epsilon = 0.0001;
  const ahead = resolveSpringPosition(
    tSec + epsilon,
    target,
    initialDelta,
    initialVelocity,
    dampingRatio,
    undampedAngularFreq,
  );
  const analyticalVelocity = (ahead - current) / epsilon;

  const isDone =
    Math.abs(analyticalVelocity) <= restSpeed && Math.abs(target - current) <= restDelta;

  if (isDone) {
    state.value = target;
    state.velocity = 0;
  } else {
    state.value = current;
    state.velocity = analyticalVelocity;
  }

  return state.value;
}

/**
 * Recordly `getCursorSpringConfig(0.67)` + camera tuning defaults
 * (cameraSpringStiffnessMultiplier 1, cameraSpringDampingMultiplier 1.13,
 * cameraSpringMassMultiplier 1.12) → overdamped glide for panning.
 */
const PAN_SPRING: SpringConfig = {
  stiffness: 357.95,
  damping: 68.36,
  mass: 1.569,
  restDelta: 0.0002,
  restSpeed: 0.01,
};

/**
 * Recordly `getZoomSpringConfig(0.5)` → barely-overdamped, fast but floaty
 * zoom settle (damping ratio ≈ 1.05).
 */
const ZOOM_SPRING: SpringConfig = {
  stiffness: 100,
  damping: 21,
  mass: 1.0,
  restDelta: 0.0005,
  restSpeed: 0.015,
};

const DEFAULT_OPTIONS: CameraSpringOptions = {
  tuning: { stiffnessMultiplier: 1.0, dampingMultiplier: 1.0, massMultiplier: 1.0 },
  startScale: 1.0,
  maxDtMs: 40,
};

export class SpringCamera {
  readonly state: CameraSpringState;
  private readonly opts: CameraSpringOptions;
  private readonly px: SpringState;
  private readonly py: SpringState;
  private readonly ps: SpringState;
  private readonly panCfg: SpringConfig;
  private readonly zoomCfg: SpringConfig;

  constructor(opts?: Partial<CameraSpringOptions>) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts, tuning: { ...DEFAULT_OPTIONS.tuning, ...opts?.tuning } };
    this.state = {
      x: 0.5,
      y: 0.5,
      vx: 0,
      vy: 0,
      scale: this.opts.startScale,
      vscale: 0,
    };
    const t = this.opts.tuning;
    this.panCfg = {
      ...PAN_SPRING,
      stiffness: PAN_SPRING.stiffness * t.stiffnessMultiplier,
      damping: PAN_SPRING.damping * t.dampingMultiplier,
      mass: PAN_SPRING.mass * t.massMultiplier,
    };
    this.zoomCfg = {
      ...ZOOM_SPRING,
      stiffness: ZOOM_SPRING.stiffness * t.stiffnessMultiplier,
      damping: ZOOM_SPRING.damping * t.dampingMultiplier,
      mass: ZOOM_SPRING.mass * t.massMultiplier,
    };
    this.px = createSpringState(this.state.x);
    this.py = createSpringState(this.state.y);
    this.ps = createSpringState(this.state.scale);
  }

  /** Recompute derived spring constants (kept for API compatibility). */
  recompute(): void {
    /* derived configs are fixed at construction; tuning changes require a new instance */
  }

  /** Advance the camera pan toward a target focus over a given dt. */
  update(targetX: number, targetY: number, dtMs: number): void {
    const dt = clamp(clampDeltaMs(Math.max(dtMs, 0)), 1, this.opts.maxDtMs);
    const nx = stepSpringValue(this.px, targetX, dt, this.panCfg);
    const ny = stepSpringValue(this.py, targetY, dt, this.panCfg);
    this.state.x = clamp(nx, 0, 1);
    this.state.y = clamp(ny, 0, 1);
    this.state.vx = this.px.velocity;
    this.state.vy = this.py.velocity;
  }

  /** Advance the zoom toward a target scale (1 = fit, >1 = zoom in). */
  updateScale(targetScale: number, dtMs: number): void {
    const dt = clamp(clampDeltaMs(Math.max(dtMs, 0)), 1, this.opts.maxDtMs);
    const ns = stepSpringValue(this.ps, Math.max(1, targetScale), dt, this.zoomCfg);
    this.state.scale = Math.max(1, ns);
    this.state.vscale = this.ps.velocity;
  }

  /** Immediately snap to a target (used on start / large jumps). */
  snapTo(x: number, y: number, scale?: number): void {
    this.state.x = clamp(x, 0, 1);
    this.state.y = clamp(y, 0, 1);
    this.state.vx = 0;
    this.state.vy = 0;
    resetSpringState(this.px, this.state.x);
    resetSpringState(this.py, this.state.y);
    if (scale !== undefined) {
      this.state.scale = Math.max(1, scale);
      this.state.vscale = 0;
      resetSpringState(this.ps, this.state.scale);
    }
  }
}