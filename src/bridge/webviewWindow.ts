import { tauriInvokeRaw } from "./runtime";

export class WebviewWindow {
  private readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  static getByLabel(label: string): Promise<WebviewWindow | null> {
    return tauriInvokeRaw<boolean>("__dc_window_exists", { label }).then((exists) =>
      exists ? new WebviewWindow(label) : null,
    );
  }

  isMinimized() {
    return tauriInvokeRaw<boolean>("__dc_window_property", {
      label: this.label,
      prop: "isMinimized",
    });
  }

  isVisible() {
    return tauriInvokeRaw<boolean>("__dc_window_property", {
      label: this.label,
      prop: "isVisible",
    });
  }

  async show(): Promise<void> {
    await tauriInvokeRaw<void>("__dc_window_control", { label: this.label, action: "show" });
  }

  async hide(): Promise<void> {
    await tauriInvokeRaw<void>("__dc_window_control", { label: this.label, action: "hide" });
  }

  async close(): Promise<void> {
    await tauriInvokeRaw<void>("__dc_window_control", { label: this.label, action: "close" });
  }

  async setFocus(): Promise<void> {
    await tauriInvokeRaw<void>("__dc_window_control", { label: this.label, action: "focus" });
  }

  async minimize(): Promise<void> {
    await tauriInvokeRaw<void>("__dc_window_control", { label: this.label, action: "minimize" });
  }

  async unminimize(): Promise<void> {
    await tauriInvokeRaw<void>("__dc_window_control", {
      label: this.label,
      action: "unminimize",
    });
  }

  async setPosition(x: number, y: number): Promise<void> {
    await tauriInvokeRaw<void>("__dc_window_control", {
      label: this.label,
      action: "position",
      x,
      y,
    });
  }

  async setSize(w: number, h: number): Promise<void> {
    await tauriInvokeRaw<void>("__dc_window_control", {
      label: this.label,
      action: "size",
      w,
      h,
    });
  }

  async setAlwaysOnTop(v: boolean): Promise<void> {
    await tauriInvokeRaw<void>("__dc_window_control", {
      label: this.label,
      action: "alwaysOnTop",
      v,
    });
  }
}