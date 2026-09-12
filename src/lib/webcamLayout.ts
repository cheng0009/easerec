/**
 * Webcam picture-in-picture layout — maps the user's webcam panel config
 * (position / size / shape / border) into output-canvas geometry. PURE, so
 * the composer just draws what this returns.
 */

export interface WebcamConfig {
  position: "bottom_right" | "bottom_left" | "top_right" | "top_left" | "custom";
  customX: number;
  customY: number;
  sizeRatio: number;
  shape: "circle" | "rounded_rect" | "rect";
  borderColor: string;
  borderWidth: number;
  cornerRadius: number;
}

export interface WebcamLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  circle: boolean;
  border: { color: string; width: number };
}

/** Aspect fallback when the camera stream size is not known yet. */
export function webcamLayout(
  outW: number,
  outH: number,
  cfg: WebcamConfig,
  camAspect = 4 / 3,
  pad = 24,
): WebcamLayout {
  const w = Math.max(8, outW * Math.max(0.05, Math.min(0.5, cfg.sizeRatio)));
  const h = w / Math.max(0.5, camAspect);
  let x: number;
  let y: number;
  switch (cfg.position) {
    case "bottom_left": x = pad; y = outH - h - pad; break;
    case "top_right": x = outW - w - pad; y = pad; break;
    case "top_left": x = pad; y = pad; break;
    case "custom":
      x = Math.max(pad, Math.min(outW - w - pad, cfg.customX * outW - w / 2));
      y = Math.max(pad, Math.min(outH - h - pad, cfg.customY * outH - h / 2));
      break;
    case "bottom_right":
    default:
      x = outW - w - pad;
      y = outH - h - pad;
  }
  const radius = cfg.shape === "circle" ? Math.min(w, h) / 2 : w * Math.max(0, Math.min(0.5, cfg.cornerRadius));
  return {
    x, y, w, h,
    radius,
    circle: cfg.shape === "circle",
    border: { color: cfg.borderColor, width: Math.max(0, Math.round(cfg.borderWidth)) },
  };
}
