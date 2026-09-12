/**
 * Central bridge runtime shared by all Tauri-compatible shims.
 *
 * The Electron preload exposes `window.__directorcam` as the IPC contract:
 *   - `invoke(cmd, args)`      -> Promise resolving to the command result
 *   - `register(event, fn)`    -> subscribe to main->page events, returns unsubscribe
 *   - `call`                   -> lower-level bus used by invoke/register
 */

export interface BridgeContract {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  call: (type: string, payload?: unknown) => Promise<unknown>;
  on: (type: string, fn: (payload: unknown) => void) => void;
  off: (type: string, fn: (payload: unknown) => void) => void;
}

function getBridge(): BridgeContract | null {
  const g = globalThis as { __directorcam?: BridgeContract };
  return g.__directorcam ?? null;
}

/** Wait until the preload bridge is ready (preload may still be loading). */
export async function waitForBridge(timeoutMs = 8000): Promise<BridgeContract> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const b = getBridge();
    if (b) return b;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("DirectorCam bridge not available. Run inside the Electron app.");
}

/** Generic command invoke (mirrors Tauri's `invoke`). */
export async function tauriInvokeRaw<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const bridge = await waitForBridge();
  const result = await bridge.invoke(cmd, args);
  if (result && typeof result === "object" && "ok" in result) {
    const r = result as { ok: boolean; data?: unknown; error?: string };
    if (!r.ok) throw new Error(r.error ?? "Command failed");
    return r.data as T;
  }
  return result as T;
}

/** Cross-process subscription (mirrors Tauri's `listen`). */
export async function listenRaw<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const bridge = await waitForBridge();
  const fn = (p: unknown) => handler(p as T);
  bridge.on(event, fn);
  return () => bridge.off(event, fn);
}