/**
 * Floating teleprompter: renderer-side bridge + pure script helpers.
 *
 * The store slice `settings.teleprompter` is the page's working copy. Any
 * change is pushed to the main process (`teleprompter_set`), which forwards it
 * to the floating prompter window AND owns the window's visibility/bounds.
 * Edits made inside the prompter window itself (font +/-, speed, ✕) come back
 * over `teleprompter-state` and are applied to the store so the panel stays in
 * sync; `syncing` guards that inbound write so it never re-pushes an echo.
 */

import { useStore } from "../store";
import { tauriInvoke, listenEvent } from "../lib/tauri";
import type { TeleprompterState } from "../store/types";
import { clampFontSize, clampSpeed } from "./teleprompterText";
export {
  splitParagraphs,
  normalizeScriptText,
  clampFontSize,
  clampSpeed,
} from "./teleprompterText";

/** Push the current teleprompter state to the main process (fire + forget). */
export function pushTeleprompterState(state: TeleprompterState): void {
  void tauriInvoke("teleprompter_set", { state }).catch(() => {});
}

/** F2: flip the floating window's visibility and apply it immediately. */
export function toggleTeleprompter(): void {
  const tp = { ...useStore.getState().settings.teleprompter };
  tp.visible = !tp.visible;
  useStore.getState().setSettings({ teleprompter: tp });
}

/** Keep the store in sync with font/speed/hide edits made in the floating
 *  window (they arrive as `teleprompter-state` echoes from the main process). */
export function installTeleprompterSync(): void {
  void listenEvent<TeleprompterState>("teleprompter-state", (st) => {
    if (!st || typeof st !== "object") return;
    const cur = useStore.getState().settings.teleprompter;
    if (cur.text === st.text && cur.fontSize === st.fontSize
      && cur.speed === st.speed && cur.visible === st.visible) return;
    syncing = true;
    useStore.getState().setSettings({
      teleprompter: {
        text: typeof st.text === "string" ? st.text : cur.text,
        fontSize: clampFontSize(st.fontSize),
        speed: clampSpeed(st.speed),
        visible: typeof st.visible === "boolean" ? st.visible : cur.visible,
      },
    });
    setTimeout(() => { syncing = false; }, 60);
  }).catch(() => {});
}

/** Guard against echo loops: inbound sync writes must not re-push. */
let syncing = false;

/** Push every store change to the main process; returns the unsubscribe fn. */
export function subscribeTeleprompterPush(): () => void {
  return useStore.subscribe((state, prev) => {
    const tp = state.settings.teleprompter;
    if (syncing || !tp || prev.settings.teleprompter === tp) return;
    pushTeleprompterState(tp);
  });
}