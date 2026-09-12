import { tauriInvokeRaw } from "./runtime";

export async function openPath(path: string): Promise<void> {
  await tauriInvokeRaw<void>("__dc_shell_open", { path });
}

export async function openUrl(url: string): Promise<void> {
  await tauriInvokeRaw<void>("__dc_shell_open_url", { url });
}

export async function revealInDir(path: string): Promise<void> {
  await tauriInvokeRaw<void>("__dc_reveal_in_dir", { path });
}