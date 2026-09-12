import { tauriInvokeRaw } from "./runtime";

export interface CurrentWindow {
  label: string;
  isMinimized: () => Promise<boolean>;
  minimize: () => Promise<void>;
  unminimize: () => Promise<void>;
  hide: () => Promise<void>;
  show: () => Promise<void>;
  setFocus: () => Promise<void>;
  setPosition: (x: number, y: number) => Promise<void>;
  setSize: (w: number, h: number) => Promise<void>;
  close: () => Promise<void>;
  [k: string]: unknown;
}

/** Minimal mirror of @tauri-apps/api/window#getCurrentWindow. */
export function getCurrentWindow(): CurrentWindow {
  const invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) =>
    tauriInvokeRaw<T>(cmd, args);

  return {
    label: "main",
    isMinimized: () => invoke<boolean>("__dc_window_property", { prop: "isMinimized" }),
    minimize: () => invoke<void>("__dc_window_control", { action: "minimize" }),
    unminimize: () => invoke<void>("__dc_window_control", { action: "unminimize" }),
    hide: () => invoke<void>("__dc_window_control", { action: "hide" }),
    show: () => invoke<void>("__dc_window_control", { action: "show" }),
    setFocus: () => invoke<void>("__dc_window_control", { action: "focus" }),
    setPosition: (x, y) => invoke<void>("__dc_window_control", { action: "position", x, y }),
    setSize: (w, h) => invoke<void>("__dc_window_control", { action: "size", w, h }),
    close: () => invoke<void>("__dc_window_control", { action: "close" }),
  };
}