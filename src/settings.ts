/**
 * Renderer-side copy of the default shortcut configuration. Used by the
 * in-window keydown fallback so hotkeys still work when the global shortcut
 * cannot be registered by the OS (or when the main process is unreachable).
 * Keep in sync with `defaultShortcuts()` in electron/main.ts.
 */

export interface ShortcutItem {
  key: string;
  modifiers?: string[];
}

export interface ShortcutsConfig {
  [name: string]: ShortcutItem;
}

export const DEFAULT_SHORTCUTS: ShortcutsConfig = {
  toggle_recording: { key: "F9", modifiers: [] },
  toggle_studio: { key: "F1", modifiers: [] },
  toggle_ff: { key: "F4", modifiers: [] },
  toggle_privacy: { key: "F6", modifiers: [] },
  toggle_privacy_cut: { key: "F6", modifiers: ["SHIFT"] },
  toggle_pause: { key: "F10", modifiers: [] },
  toggle_magnifier: { key: "Digit1", modifiers: ["CONTROL"] },
  toggle_step_marker: { key: "Digit2", modifiers: ["CONTROL"] },
  toggle_highlighter: { key: "Digit3", modifiers: ["CONTROL"] },
  toggle_ripple: { key: "KeyR", modifiers: ["CONTROL"] },
  zoom_cycle: { key: "Equal", modifiers: [] },
  zoom_level_1: { key: "Digit4", modifiers: ["CONTROL"] },
  zoom_level_2: { key: "Digit5", modifiers: ["CONTROL"] },
  zoom_level_3: { key: "Digit6", modifiers: ["CONTROL"] },
};

export function defaultShortcutsConfig(): ShortcutsConfig {
  return DEFAULT_SHORTCUTS;
}
