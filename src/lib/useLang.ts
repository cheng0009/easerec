import { useStore } from "../store";

/**
 * Bilingual string helper for the hub UI. Returns a picker bound to the
 * current language; every component that calls this re-renders on switch.
 *   const L = useLang();
 *   L("工作台", "Studio")
 */
export function useLang(): (zh: string, en: string) => string {
  const lang = useStore((s) => s.current);
  const isZh = lang !== "en";
  return (zh: string, en: string) => (isZh ? zh : en);
}

/** Non-component contexts (IPC handlers etc.): read the persisted language. */
export function isZhLang(): boolean {
  try { return (localStorage.getItem("directorcam_lang") ?? "zh-CN") !== "en"; }
  catch { return true; }
}
