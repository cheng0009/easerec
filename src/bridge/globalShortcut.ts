import { tauriInvokeRaw } from "./runtime";

/** Stub matching @tauri-apps/plugin-global-shortcut surface. */
export async function register(_shortcut: unknown): Promise<void> {
  await tauriInvokeRaw<void>("__dc_register_shortcut", { shortcut: _shortcut });
}

export async function unregister(shortcut: unknown): Promise<void> {
  await tauriInvokeRaw<void>("__dc_unregister_shortcut", { shortcut });
}

export async function unregisterAll(): Promise<void> {
  await tauriInvokeRaw<void>("__dc_unregister_all_shortcuts");
}

export async function isRegistered(shortcut: unknown): Promise<boolean> {
  return tauriInvokeRaw<boolean>("__dc_is_shortcut_registered", { shortcut });
}

export async function onPress(shortcut: unknown, handler: () => void): Promise<unknown> {
  const { listenRaw } = await import("./runtime");
  listenRaw("dc-hotkey", (p: unknown) => {
    const { id } = p as { id?: string };
    void id;
    handler();
  }).catch(() => {});
  await register(shortcut);
  return () => unregisterAll();
}