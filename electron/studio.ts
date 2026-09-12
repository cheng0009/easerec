/**
 * Studio Mode desktop features (Electron 版). Restores the Tauri-era Win32
 * capabilities that the web renderer cannot reach:
 *   - hide/show desktop icons       (Progman WM_COMMAND 0x7402 toggle)
 *   - pin a backdrop window to the very bottom of the z-order
 *     (SetWindowPos HWND_BOTTOM) so the recorded desktop background is a
 *     clean solid color behind the captured window
 *
 * Everything degrades gracefully when koffi/the native module is unavailable.
 * Pure geometry (16:9 arrangement math) lives in studioRect and is tested.
 */

type KoffiFn = (...args: unknown[]) => unknown;

interface Win32 {
  FindWindowW: KoffiFn;
  SendMessageW: KoffiFn;
  SetWindowPos: KoffiFn;
}

let win32: Win32 | null | undefined;

function loadWin32(): Win32 | null {
  if (win32 !== undefined) return win32;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as { load: (dll: string) => { func: (sig: string) => KoffiFn } };
    const user32 = koffi.load("user32.dll");
    win32 = {
      FindWindowW: user32.func("int FindWindowW(const char16_t* cls, const char16_t* title)"),
      SendMessageW: user32.func("int SendMessageW(int hwnd, int msg, int wparam, int lparam)"),
      SetWindowPos: user32.func("int SetWindowPos(int hwnd, int after, int x, int y, int w, int h, int flags)"),
    };
  } catch (e) {
    console.warn("[studio] koffi unavailable — studio desktop features disabled", e);
    win32 = null;
  }
  return win32;
}

const WM_COMMAND = 0x0111;
/** Progman's hidden "toggle desktop icons" command. */
const PROGMAN_TOGGLE_ICONS = 0x7402;
const HWND_BOTTOM = 1;
const SWP_NOMOVE = 0x0002;
const SWP_NOSIZE = 0x0004;
const SWP_NOACTIVATE = 0x0010;

/** Toggles desktop icon visibility. Returns true when the message was sent. */
export function toggleDesktopIcons(): boolean {
  const w = loadWin32();
  if (!w) return false;
  try {
    const hwnd = w.FindWindowW("Progman", null) as number;
    if (!hwnd) return false;
    w.SendMessageW(hwnd, WM_COMMAND, PROGMAN_TOGGLE_ICONS, 0);
    return true;
  } catch (e) {
    console.warn("[studio] toggleDesktopIcons failed", e);
    return false;
  }
}

/** Push a native window handle (Buffer from BrowserWindow.getNativeWindowHandle) to the bottom. */
export function sendWindowToBottom(nativeHandle: Buffer): boolean {
  const w = loadWin32();
  if (!w) return false;
  try {
    // read the HWND (pointer-sized) from the handle buffer
    const hwnd = nativeHandle.readUInt32LE(0) + nativeHandle.readUInt32LE(4) * 0x100000000;
    const flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
    w.SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, flags);
    return true;
  } catch (e) {
    console.warn("[studio] sendWindowToBottom failed", e);
    return false;
  }
}

/**
 * Centered 16:9 rect inside the given screen bounds — the arrangement the
 * recorded window should take in Studio Mode (used by the backdrop layout).
 */
export function studioRect(screenW: number, screenH: number): { x: number; y: number; w: number; h: number } {
  const aspect = 16 / 9;
  let w = screenW;
  let h = w / aspect;
  if (h > screenH) {
    h = screenH;
    w = h * aspect;
  }
  return {
    x: Math.round((screenW - w) / 2),
    y: Math.round((screenH - h) / 2),
    w: Math.round(w),
    h: Math.round(h),
  };
}
