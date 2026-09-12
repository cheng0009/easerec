import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export function useTauriEvent<T>(event: string, handler: (payload: T) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<T>(event, (e) => handlerRef.current(e.payload)).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [event]);
}
