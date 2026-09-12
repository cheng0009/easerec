import { invoke } from "@tauri-apps/api/core";

/** 通用 Tauri invoke 封装 */
export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

/** 监听 Tauri 后端事件 */
export async function listenEvent<T>(event: string, handler: (payload: T) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => handler(e.payload));
}
