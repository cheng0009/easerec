/**
 * Started once from App. Hooks the global Director facade:
 *   - starts the live screen capture for preview
 *   - feeds global cursor position into the smart-zoom anti-shake system
 *   - routes global hotkey events from main process
 */

import { getDirector } from "./director";
import { listenEvent } from "../lib/tauri";
import { useStore } from "../store";
import { defaultShortcutsConfig, type ShortcutItem as ShortcutItemType } from "../settings";
import { toggleRecording } from "./startRecording";
import { installMarksBridge } from "./marks";
import { toggleTeleprompter, installTeleprompterSync, subscribeTeleprompterPush } from "./teleprompter";

let installed = false;

/** Guard against the same command being fired more than once per short window
 *  (e.g. both a global shortcut and an in-window keydown handler catching the
 *  same key press would otherwise double-toggle). */
const lastHotkeyAt = new Map<string, number>();
function debounceHotkey(cmd: string): boolean {
  const now = Date.now();
  const last = lastHotkeyAt.get(cmd) ?? 0;
  if (now - last < 250) return false;
  lastHotkeyAt.set(cmd, now);
  return true;
}

async function handleHotkey(cmd: string): Promise<void> {
  if (!debounceHotkey(cmd)) return;
  console.log(`[hotkey] dispatch: ${cmd}`);
  const dir = getDirector();
  const st = useStore.getState();
  switch (cmd) {
    case "toggle-recording":
      try {
        const saved = await toggleRecording();
        // Hotkey stop lands in review mode, same as the ControlBar button —
        // otherwise the stage falls back to the empty/preview look.
        if (saved) useStore.getState().setUi({ reviewPath: saved });
      }
      catch (e) { console.error("[hotkey] toggle-recording failed:", e); }
      break;
    case "toggle-studio":
      try { await import("../lib/tauri").then((m) => m.tauriInvoke("toggle_studio_mode")); } catch (e) { console.error("[hotkey] toggle-studio failed:", e); }
      break;
    case "toggle-prompter":
      // F2: show/hide the floating teleprompter window.
      try { toggleTeleprompter(); } catch (e) { console.error("[hotkey] toggle-prompter failed:", e); }
      break;
    case "cycle-audio": {
      const order: Array<"system" | "mic" | "both"> = ["system", "mic", "both"];
      const cur = st.recording.audioSource;
      const next = order[(order.indexOf(cur) + 1) % order.length];
      st.setRecording({ audioSource: next });
      try { await import("../lib/tauri").then((m) => m.tauriInvoke("set_audio_source", { source: next })); } catch { /* ignore */ }
      break;
    }
    case "toggle-webcam": {
      try {
        const wc = useStore.getState().webcam;
        if (wc.enabled) {
          await dir.recorder.stopWebcam();
          st.setWebcam({ enabled: false });
        } else {
          const ok = await dir.recorder.startWebcam();
          st.setWebcam({ enabled: ok });
        }
      } catch (e) { console.error("[hotkey] toggle-webcam failed:", e); }
      break;
    }
    case "toggle-ff": {
      try {
        const m = await import("./marks");
        await m.toggleFF();
      } catch (e) { console.error("[hotkey] toggle-ff failed:", e); }
      break;
    }
    case "toggle-privacy": {
      try {
        const m = await import("./marks");
        await m.togglePrivacy();
      } catch (e) { console.error("[hotkey] toggle-privacy failed:", e); }
      break;
    }
    case "toggle-pause": {
      try {
        const m = await import("./marks");
        await m.togglePause();
      } catch (e) { console.error("[hotkey] toggle-pause failed:", e); }
      break;
    }
    case "toggle-privacy-cut": {
      try {
        const m = await import("./marks");
        await m.togglePrivacyCut();
      } catch (e) { console.error("[hotkey] toggle-privacy-cut failed:", e); }
      break;
    }
    case "toggle-magnifier":
      // Ctrl+1 toggles magnifier MODE. While active, the lens follows the mouse
      // live (and the whole-frame follow-zoom stays off). ESC exits the mode.
      st.setEffects({ activeMagnifier: !st.effects.activeMagnifier });
      break;
    case "toggle-highlighter":
      st.setEffects({ activeHighlighter: !st.effects.activeHighlighter });
      break;
    case "toggle-ripple":
      st.setEffects({ rippleEnabled: !st.effects.rippleEnabled });
      break;
    case "toggle-step-marker": {
      // Ctrl+2 toggles step-marker MODE: while active each mouse click drops the
      // next numbered marker. Entering starts fresh numbering; exiting clears.
      const willEnable = !st.effects.stepModeActive;
      st.setEffects({
        stepModeActive: willEnable,
        stepMarkers: willEnable ? [] : st.effects.stepMarkers,
      });
      break;
    }
    case "toggle-zoom": {
      try { dir.setZoomEnabled(!dir.recorder.smartZoom.config.enabled); } catch (e) { console.error("[hotkey] toggle-zoom failed:", e); }
      break;
    }
    case "zoom-cycle": {
      const levels = [1.0, 1.5, 2.0];
      const cur = dir.recorder.smartZoom.config.zoomLevel;
      const next = levels[(levels.indexOf(cur) + 1) % levels.length] ?? 1.0;
      dir.setZoomLevel(next);
      break;
    }
    // Digits 1/2/3 are context-aware: while a tool is active they configure it
    // (magnifier zoom level / marker color / pen style); otherwise they fall
    // back to the classic smart-zoom levels.
    case "zoom-level-1":
    case "zoom-level-2":
    case "zoom-level-3": {
      handleToolDigit(Number(cmd.replace("zoom-level-", "")));
      break;
    }
    default: break;
  }
}

/** Digit 1/2/3 routing by active annotation tool. */
function handleToolDigit(n: number): void {
  const st = useStore.getState();
  const eff = st.effects;
  // Any annotation effect active → digits only switch magnifier lens
  // level, preventing accidental smart-zoom ("screen operation") or
  // other tool adjustments while presenting.
  if (eff.activeMagnifier || eff.stepModeActive || eff.activeHighlighter || eff.rippleEnabled) {
    st.setEffects({ lensLevel: n });
    return;
  }
  const levels = [1.0, 1.5, 2.0];
  try { getDirector().setZoomLevel(levels[n - 1] ?? 1.0); } catch { /* ignore */ }
}

/** Turn off every annotation mode and clear the markers (ESC). NOTE: ripple is
 *  intentionally NOT here — ripple clicks operate the window below, which may
 *  rely on ESC itself, so ripple only exits via its own Alt+R toggle. */
function exitAnnotationModes(): void {
  const st = useStore.getState();
  const eff = st.effects;
  if (
    eff.activeMagnifier || eff.activeHighlighter ||
    eff.stepModeActive || eff.stepMarkers.length > 0
  ) {
    st.setEffects({
      activeMagnifier: false,
      activeHighlighter: false,
      stepModeActive: false,
      stepMarkers: [],
    });
  }
}

/** In-window keydown handler for all shortcuts. Reliable whenever the app is
 *  focused (globalShortcut often "registers OK" on Windows yet still fails to
 *  deliver, e.g. Ctrl+number may be grabbed by the IME). The debounce in
 *  handleHotkey() prevents double-toggling when a global hotkey also fires. */
let fallbackCombos: { cmd: string; key: string; code: string; ctrl: boolean; alt: boolean; shift: boolean }[] = [];
let fallbackInstalled = false;

function normKey(k: string): string {
  return typeof k === "string" ? k.toLowerCase() : "";
}

function buildFallbackCombos(cfg: Record<string, ShortcutItemType | undefined>): void {
  fallbackCombos = [];
  const push = (cmd: string, item?: ShortcutItemType) => {
    const m = (item?.modifiers ?? []).map(normKey);
    fallbackCombos.push({
      cmd,
      key: normKey(item?.key ?? ""),
      code: normKey(item?.key ?? ""),
      ctrl: m.includes("control") || m.includes("ctrl"),
      alt: m.includes("alt"),
      shift: m.includes("shift"),
    });
  };
  push("toggle-recording", cfg.toggle_recording);
  push("toggle-studio", cfg.toggle_studio);
  push("toggle-prompter", cfg.toggle_prompter);
  push("toggle-ff", cfg.toggle_ff);
  push("toggle-privacy", cfg.toggle_privacy);
  push("toggle-privacy-cut", cfg.toggle_privacy_cut);
  push("toggle-magnifier", cfg.toggle_magnifier);
  push("toggle-step-marker", cfg.toggle_step_marker);
  push("toggle-highlighter", cfg.toggle_highlighter);
  push("toggle-ripple", cfg.toggle_ripple);
  push("zoom-cycle", cfg.zoom_cycle);
  push("zoom-level-1", cfg.zoom_level_1);
  push("zoom-level-2", cfg.zoom_level_2);
  push("zoom-level-3", cfg.zoom_level_3);
}

function installKeydownFallback(): void {
  if (fallbackInstalled) return;
  fallbackInstalled = true;

  // Start with the defaults so keys work immediately, then adopt the saved
  // config once the main process answers (custom Alt+Q/W/E/R … hotkeys).
  buildFallbackCombos(defaultShortcutsConfig());

  window.addEventListener("keydown", (e) => {
    const key = normKey(e.key);
    const code = normKey(e.code);
    for (const c of fallbackCombos) {
      const pressed = key === c.key || code === c.code;
      if (pressed && e.ctrlKey === c.ctrl && e.altKey === c.alt && e.shiftKey === c.shift) {
        e.preventDefault();
        void handleHotkey(c.cmd);
        return;
      }
    }
  });

  try {
    import("../lib/tauri").then((m) =>
      m.tauriInvoke<Record<string, ShortcutItemType>>("get_shortcut_config").then((cfg) => {
        refreshFallbackShortcuts(cfg);
      }),
    ).catch(() => { /* keep defaults */ });
  } catch { /* keep defaults */ }
}

/** Rebuild the in-window fallback combos after a shortcut config change so the
 *  new bindings work immediately without an app restart. */
export function refreshFallbackShortcuts(cfg?: Record<string, ShortcutItemType | undefined>): void {
  if (cfg && typeof cfg === "object" && Object.keys(cfg).length > 0) {
    buildFallbackCombos(cfg);
  }
}

export function installDirectorController(): void {
  if (installed) return;
  installed = true;

  const director = getDirector();
  director.recorder.setErrorHandler((msg) => {
    try { useStore.getState().setMarks({ feedback: msg }); } catch {}
  });

  installMarksBridge();

  // Floating teleprompter: push store changes to the main process and merge
  // in-window edits (font/speed/close) back into the store.
  installTeleprompterSync();
  subscribeTeleprompterPush();

  void director.startScreen();

  installKeydownFallback();

  // Desktop overlay mirror (magnifier / step markers / highlighter over the
  // real desktop, which is the captured single-source of annotation effects).
  void import("./overlaySync").then((m) => m.startOverlaySync());

  void listenEvent<{ x: number; y: number }>("dc-cursor", (p) => {
    try { director.recorder.setCursorPosition(p.x, p.y); } catch { /* ignore */ }
  }).catch(() => {});

  // Global mouse click (from the main-process input hook): while step-marker
  // mode is on, each physical click places the next numbered marker at the
  // cursor (normalized to the overlay/screen size).
  void listenEvent<{ x: number; y: number }>("dc-mouse-click", (p) => {
    try {
      const st = useStore.getState();
      if (!st.effects.stepModeActive) return;
      const dispW = Math.max(1, window.screen?.width || st.effects.stepMarkers.length + 1);
      const dispH = Math.max(1, window.screen?.height || 1);
      st.setEffects({
        stepMarkers: [
          ...st.effects.stepMarkers,
          {
            id: Date.now(),
            x: Math.max(0, Math.min(1, p.x / dispW)),
            y: Math.max(0, Math.min(1, p.y / dispH)),
          },
        ],
      });
    } catch { /* ignore */ }
  }).catch(() => {});

  // Global Escape (polled in main via koffi): exiting effect modes works even
  // when the window is minimized/mini. In-window keydown below is the fallback
  // when the native hook is unavailable.
  void listenEvent<{ key: string }>("dc-key", (p) => {
    if (p && p.key === "Escape") exitAnnotationModes();
  }).catch(() => {});

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      exitAnnotationModes();
    }
  });

  void listenEvent<{ cmd: string }>("dc-hotkey", (p) => {
    void handleHotkey(p.cmd);
  }).catch(() => {});

  (globalThis as { __director?: unknown }).__director = director;
}