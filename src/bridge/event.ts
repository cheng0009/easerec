import { listenRaw } from "./runtime";

export type UnlistenFn = () => void;
export interface Event<T> {
  payload: T;
}

/** Subscribe to a main-process event; returns an unsubscribe function. */
export async function listen<T = unknown>(
  event: string,
  handler: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  return listenRaw<T>(event, (payload) => handler({ payload }));
}

export type EventHandler<T = unknown> = (event: Event<T>) => void;
export function emit(event: string, payload?: unknown): void {
  const g = globalThis as {
    __directorcam?: { call: (type: string, payload?: unknown) => Promise<unknown> };
  };
  g.__directorcam?.call("emit", { event, payload }).catch(() => {});
}