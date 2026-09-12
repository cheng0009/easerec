import { tauriInvokeRaw } from "./runtime";

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
  [k: string]: unknown;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
  [k: string]: unknown;
}

/**
 * Native folder / file picker. Mirrors @tauri-apps/plugin-dialog `open`.
 * Returns a string (single) or string[] (multiple), or null if cancelled.
 */
export async function open(
  options?: OpenDialogOptions,
): Promise<string | string[] | null> {
  return tauriInvokeRaw<string | string[] | null>("__dc_open_dialog", {
    directory: options?.directory ?? false,
    multiple: options?.multiple ?? false,
    title: options?.title,
    defaultPath: options?.defaultPath,
    filters: options?.filters,
  });
}

/** Native save dialog. */
export async function save(
  options?: SaveDialogOptions,
): Promise<string | null> {
  return tauriInvokeRaw<string | null>("__dc_save_dialog", {
    title: options?.title,
    defaultPath: options?.defaultPath,
    filters: options?.filters,
  });
}

export async function messageDialog(): Promise<void> {
  // Simple no-op; not used by the current UI.
}