/**
 * Preload — runs in web contents context before the page. Uses Electron's
 * `contextBridge` to expose the `__directorcam` contract that the
 * page shims (`@tauri-apps/*`, `src/bridge/*`) depend on.
 *
 * Contract:
 *   __directorcam.invoke(cmd, args)   -> Promise<any>
 *   __directorcam.on(event, fn)       -> subscribe main->page events
 *   __directorcam.off(event, fn)      -> unsubscribe
 */

const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Map<string, Array<(payload: unknown) => void>>();

function onMessage(event: string, raw: unknown): void {
  const fns = listeners.get(event);
  if (!fns) return;
  for (const fn of [...fns]) {
    try { fn(raw); } catch { /* ignore */ }
  }
}

ipcRenderer.on("dc-event", (_event: unknown, payload: { event: string; data?: unknown }) => {
  if (payload && typeof payload.event === "string") {
    onMessage(payload.event, payload.data);
  }
});

const LEGACY_CMDS = new Set([
  "__dc_open_dialog",
  "__dc_save_dialog",
  "__dc_save_recording",
  "__dc_window_exists",
  "__dc_window_property",
  "__dc_window_control",
  "__dc_shell_open",
  "__dc_shell_open_url",
  "__dc_reveal_in_dir",
  // Mini console channels are registered as top-level ipcMain.handle()
  // channels, so they must be invoked directly (not via dc-invoke).
  "mini_command",
  "mini_state_update",
  "mini_time_update",
]);

contextBridge.exposeInMainWorld("__directorcam", {
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (LEGACY_CMDS.has(cmd)) return ipcRenderer.invoke(cmd, args);
    return ipcRenderer.invoke("dc-invoke", cmd, args);
  },
  call: async (type: string, payload?: unknown) => ipcRenderer.invoke("dc-call", type, payload),
  send: (channel: string, payload?: unknown) => {
    // Only allow whitelisted push channels to the main process.
    if (channel === "dc-overlay-send" || channel === "dc-overlay-clear" || channel === "dc-overlay-shield" || channel === "dc-focus-render-ready" || channel === "dc-focus-render-progress") {
      ipcRenderer.send(channel, payload);
    }
  },
  on: (type: string, fn: (payload: unknown) => void) => {
    const arr = listeners.get(type) ?? [];
    arr.push(fn);
    listeners.set(type, arr);
  },
  off: (type: string, fn: (payload: unknown) => void) => {
    const arr = listeners.get(type) ?? [];
    listeners.set(type, arr.filter((f) => f !== fn));
  },
});

contextBridge.exposeInMainWorld("directorcamBridge", {
  ipcInvoke: (cmd: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("dc-invoke", cmd, args ?? {}),
  ipcListen: (event: string) =>
    ipcRenderer.invoke("dc-listen", event).catch(() => false),
  _on: (type: string, fn: (payload: unknown) => void) => {
    const arr = listeners.get(type) ?? [];
    arr.push(fn);
    listeners.set(type, arr);
  },
  _off: (type: string, fn: (payload: unknown) => void) => {
    const arr = listeners.get(type) ?? [];
    listeners.set(type, arr.filter((f) => f !== fn));
  },
});
