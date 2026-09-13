import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  Tray,
} from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import {
  resolveFfmpeg,
  projectPath,
  appData,
  ensureDir,
  shellOpen,
  revealInDir,
  saveRecordingBytes,
} from "./helpers";
import { RecordingSession, listRecordings, readEdlFile, sidecarPaths, writeEdlFile } from "./recordingSession";
import { scanBacktrace } from "./backtrace";
import { runExportPipeline } from "./export/run";
import type { ExportSettings } from "./export/plan";
import type { EditEntry, EdlFile } from "../src/recording/edl";
import { emptyEdl, privacyCutForMask } from "../src/recording/edl";
import { toggleDesktopIcons, sendWindowToBottom } from "./studio";
import { resolveWhisper } from "./subtitles/whisper";

// App icon: Windows uses the multi-size build/icon.ico (dev/runtime window +
// taskbar); electron-builder embeds the same .ico into the packaged exe.
/** Resolve a bundled icon from the project (dev) or packaged resources. */
function resolveIcon(name: string): string | undefined {
  const candidates = [
    projectPath("build", name),
    process.resourcesPath ? path.join(process.resourcesPath, name) : "",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return undefined;
}
const ICON_PATH = resolveIcon("icon.ico");
const TRAY_ICON = resolveIcon("icon-256.png") || resolveIcon("icon.png");

/** Enumerate installed Windows font family names via GDI+ (PowerShell). */
async function listSystemFonts(): Promise<string[]> {
  try {
    const ps = "Add-Type -AssemblyName System.Drawing; " +
      "(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";
    const out = await new Promise<string>((resolve, reject) => {
      execFile("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const names = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return [...new Set(names)].sort((a, b) => a.localeCompare(b, "zh-CN"));
  } catch {
    return [];
  }
}
const APP_ICON = process.platform === "win32" && ICON_PATH ? ICON_PATH : undefined;

let mainWindow: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let appQuitting = false;

let miniContents: Electron.WebContents | null = null;
let mainContents: Electron.WebContents | null = null;
let overlayWindow: BrowserWindow | null = null;
let overlayContents: Electron.WebContents | null = null;
// While any annotation effect is visible the transparent overlay must swallow
// clicks (drawing must never operate the windows below). The page signals this
// through `dc-overlay-shield` and we flip setIgnoreMouseEvents accordingly.
let overlayShield = false;
let lastSavedRecording: string | null = null;
let globallyFailedShortcuts: string[] = [];
/** The streaming recording session (incremental disk flush + EDL sidecar). */
let activeSession: RecordingSession | null = null;
/** Open privacy mask (index into the session EDL while the box is on screen). */
let openMaskIndex: number | null = null;
/** Studio Mode state: whether WE hid the desktop icons + the backdrop window. */
let studioIconsHidden = false;
let studioBackdrop: BrowserWindow | null = null;
/** Capture source granted to getDisplayMedia (set by the renderer's picker). */
let captureSourceId: string | null = null;
/** Pending region-recording selection resolver (overlay box-draw session). */
let regionSelectWait: ((v: { x: number; y: number; w: number; h: number } | null) => void) | null = null;
/** Win32 GetWindowRect (koffi), for mapping window capture geometry. */
let getWindowRect: ((hwnd: number, rect: Record<string, number>) => boolean) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffiMod = require("koffi") as unknown as {
    load: (dll: string) => { func: (sig: string) => unknown };
    struct: (name: string, fields: Record<string, string>) => unknown;
  };
  const user32 = koffiMod.load("user32.dll");
  koffiMod.struct("DC_RECT", { left: "long", top: "long", right: "long", bottom: "long" });
  getWindowRect = user32.func("bool GetWindowRect(int hwnd, _Out_ DC_RECT *rect)") as typeof getWindowRect;
} catch (e) {
  console.warn("[directorcam] GetWindowRect unavailable — window privacy mapping disabled", e);
}

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5173";

// --- Global input hook (koffi) -----------------------------------------------
// Detects left-clicks and the Escape key anywhere on the desktop, so step-marker
// mode can add one marker per physical click and ESC can exit annotation modes
// even while the DirectorCam window is minimized or unfocused. koffi is loaded
// lazily so the app still runs (without global input) if the native module is
// missing on the target machine.
type KeyStateFn = (vk: number) => number;
let getAsyncKeyState: KeyStateFn | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffiMod = require("koffi") as { load: (dll: string) => { func: (sig: string) => (vk: number) => number } };
  const user32 = koffiMod.load("user32.dll");
  getAsyncKeyState = user32.func("short GetAsyncKeyState(int vKey)");
  console.log("[directorcam] global input hook ready (koffi)");
} catch (e) {
  console.warn("[directorcam] koffi unavailable — global click/ESC detection disabled", e);
}
const VK_LBUTTON = 0x01;
const VK_ESCAPE = 0x1b;
const VK_1 = 0x31;
const VK_2 = 0x32;
const VK_3 = 0x33;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_SHIFT = 0x10;
const VK_TAB = 0x09;
/** VK_F1..VK_F12 are 0x70..0x7B. */
const VK_FKEY_BASE = 0x70;

/** Bare F-key hotkeys whose GLOBAL registration failed: the koffi poller
 *  watches them instead (same pattern as the bare digit fallback), so
 *  rewind/fast-forward/privacy keys still work when another app holds the
 *  global hotkey. Rebuilt after every registration attempt. */
let koffiHotkeyWatch: { cmd: string; accel: string; vk: number }[] = [];

const SETTINGS_FILE = () => path.join(appData(), "settings.json");
const SHORTCUTS_FILE = () => path.join(appData(), "shortcuts.json");
const RECORDING_DIR = () => appData("recordings");

/** Read + parse a JSON file, tolerating a UTF-8 BOM. Returns undefined on
 *  missing file / parse errors. */
function parseJsonFile(p: string): unknown {
  if (!fs.existsSync(p)) return undefined;
  let txt = fs.readFileSync(p, "utf8");
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  return JSON.parse(txt) as unknown;
}

function loadSettings(): Record<string, unknown> {
  let s: Record<string, unknown> = {};
  try {
    const parsed = parseJsonFile(SETTINGS_FILE());
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      s = parsed as Record<string, unknown>;
    }
  } catch { /* ignore */ }
  // The user-edited shortcuts.json (Alt+Q/W/E/R …) lives in the app data dir;
  // honor it whenever settings.json has no `shortcuts` yet. Once the user saves
  // custom shortcuts from the UI (settings.json wins) it is ignored. Check every
  // candidate dir the build has ever used.
  if (typeof s.shortcuts !== "object" || s.shortcuts === null) {
    const candidates = [
      path.join(app.getPath("userData"), "shortcuts.json"),
      SHORTCUTS_FILE(),
      path.join(os.homedir(), "AppData", "Roaming", "DirectorCam", "shortcuts.json"),
    ];
    for (const sp of candidates) {
      try {
        const sc = parseJsonFile(sp);
        if (typeof sc === "object" && sc !== null && !Array.isArray(sc)) {
          s.shortcuts = sc as Record<string, unknown>;
          break;
        }
      } catch { /* try next */ }
    }
  }
  return s;
}

function saveSettings(patch: Record<string, unknown>): void {
  const next = { ...loadSettings(), ...patch };
  try {
    ensureDir(appData());
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2), "utf8");
  } catch { /* ignore */ }
}

/** Push an event to the page. */
function pushEvent(event: string, data: unknown): void {
  if (mainContents && !mainContents.isDestroyed()) {
    try {
      mainContents.send("dc-event", { event, data });
    } catch { /* ignore */ }
  }
}

/** Show the main window (restoring from the tray / pure-stage mini). */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } catch { /* ignore */ }
}

/** Show/hide the main window (tray click toggle). */
function toggleMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide();
    else showMainWindow();
  } catch { /* ignore */ }
}

/** Tray presence: minimize hides to the notification area, the tray menu /
 *  icon click restores it — the app keeps running (recording/global hotkeys)
 *  while "minimized to tray". */
function ensureTray(): Tray | null {
  if (tray && !tray.isDestroyed()) return tray;
  let img = ICON_PATH ? nativeImage.createFromPath(ICON_PATH) : nativeImage.createEmpty();
  if (img.isEmpty() && TRAY_ICON) img = nativeImage.createFromPath(TRAY_ICON);
  if (img.isEmpty()) {
    console.warn("[directorcam] tray icon not found — system tray disabled");
    return null;
  }
  let icon = img.resize({ width: 16, height: 16 });
  if (icon.isEmpty()) icon = img;
  tray = new Tray(icon);
  tray.setToolTip("简录 EaseRec");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示 / 隐藏主界面", click: () => toggleMainWindow() },
    { type: "separator" },
    { label: "开始 / 停止录制 (F9)", click: () => pushEvent("dc-hotkey", { cmd: "toggle-recording" }) },
    { label: "开启 / 关闭纯净舞台 (F1)", click: () => pushEvent("dc-hotkey", { cmd: "toggle-studio" }) },
    { type: "separator" },
    { label: "退出", click: () => { try { tray?.destroy(); tray = null; } catch { /* ignore */ } app.quit(); } },
  ]));
  tray.on("click", () => toggleMainWindow());
  tray.on("double-click", () => showMainWindow());
  return tray;
}

/** Push an event to the desktop overlay window. */
function pushOverlay(event: string, data: unknown): void {
  if (overlayContents && !overlayContents.isDestroyed()) {
    try {
      overlayContents.send("dc-event", { event, data });
    } catch { console.warn(`[directorcam] overlay send failed: ${event}`); }
  } else {
    console.warn(`[directorcam] overlay %s dropped (no live contents)`, event);
  }
}

/** Apply the current click-shield state to the overlay window. */
function applyOverlayMouseMode(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(!overlayShield, { forward: true });
  }
}

// Persistent overlay visuals: while active, the overlay window must stay
// visible even when the recorder page clears its effect frames. The full
// state is kept so a freshly-created overlay window can replay it on load
// (the very first F6 press used to push the event BEFORE the overlay existed,
// silently dropping the draw-mode activation).
let overlayFFOn = false;
let overlayPrivacyDrawOn = false;
let overlayPrivacyBoxRect: { x: number; y: number; w: number; h: number } | null = null;
let overlayPrivacyHint = "";

/** Create (once) the always-on-top, click-through, transparent desktop overlay. */
function ensureOverlayWindow(): BrowserWindow | null {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const disp = screen.getPrimaryDisplay();
  const b = disp.bounds;
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Click-through: never steal focus or mouse events.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.on("close", () => { overlayWindow = null; overlayContents = null; });
  // Self-heal: a crashed/hung overlay page is torn down so the next
  // showOverlay/ensure re-creates a live one (a dead overlay would silently
  // swallow the F6 draw otherwise).
  win.webContents.on("render-process-gone", () => { try { win.destroy(); } catch { /* ignore */ } });
  win.webContents.on("did-finish-load", () => {
    overlayContents = win.webContents;
    // Replay persistent overlay state so a window created on demand (e.g. the
    // first privacy draw) reflects it instead of starting blank.
    pushOverlay("ov-ff", { on: overlayFFOn });
    pushOverlay("ov-privacy-draw", { on: overlayPrivacyDrawOn, hint: overlayPrivacyHint });
    pushOverlay("ov-privacy-box", { rect: overlayPrivacyBoxRect });
  });
  overlayWindow = win;
  applyOverlayMouseMode();
  if (isDev) {
    void win.loadURL(`${DEV_URL}/overlay.html`);
  } else {
    void win.loadFile(path.join(projectPath("dist"), "overlay.html"));
  }
  return win;
}

function showOverlay(visible: boolean): void {
  const win = ensureOverlayWindow();
  if (!win) return;
  try {
    if (visible) {
      // Always re-show: a window whose isVisible() lies (hidden while flagged
      // visible / raced hide+show) would otherwise swallow the F6 event into
      // an invisible overlay. showInactive is idempotent and cheap.
      win.showInactive();
    } else if (win.isVisible()) {
      win.hide();
    }
  } catch { /* ignore */ }
}

/** Fully reset privacy-overlay draw state for a FRESH recording session.
 *  Stale draw mode / box rect / click-shield left over from the previous
 *  recording could otherwise swallow the first F6 press or block the drag —
 *  each session starts clean. */
function resetOverlayPrivacyState(): void {
  overlayShield = false;
  overlayPrivacyDrawOn = false;
  overlayPrivacyBoxRect = null;
  applyOverlayMouseMode();
  pushOverlay("ov-privacy-draw", { on: false });
  pushOverlay("ov-privacy-box", { rect: null });
}

function makeWindow(opts: { mini?: boolean } = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: opts.mini ? 252 : 1280,
    height: opts.mini ? 224 : 800,
    minWidth: opts.mini ? 180 : 900,
    minHeight: opts.mini ? 120 : 600,
    frame: !opts.mini,
    transparent: !!opts.mini,
    resizable: !opts.mini,
    alwaysOnTop: !!opts.mini,
    skipTaskbar: !!opts.mini,
    show: !opts.mini,
    backgroundColor: opts.mini ? "#00000000" : "#0f1117",
    icon: APP_ICON,
    title: "简录 EaseRec",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  if (!opts.mini) {
    win.removeMenu();
    // Minimize hides to the SYSTEM TRAY (notification area bottom-right)
    // instead of the taskbar: recording and global hotkeys keep running.
    (win as unknown as { on: (e: string, cb: (ev: { preventDefault: () => void }) => void) => void }).on("minimize", (e) => {
      e.preventDefault();
      if (!appQuitting) win.hide();
    });
    // The always-on-top transparent overlay window is hidden (never closed by
    // the user). If it stays alive after the main window is closed, Electron
    // never sees "all windows closed" and the process lingers in the tray —
    // keeping the global digit hotkeys registered, which swallows 1/2/3
    // system-wide. Tear the overlay down with the main window so the app
    // actually quits, then `window-all-closed` fires app.quit().
    win.on("closed", () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
    });
  }

  win.webContents.once("did-finish-load", () => {
    if (opts.mini) {
      miniContents = win.webContents;
      // Pin to the primary display's bottom-right corner.
      try {
        const d = screen.getPrimaryDisplay().workArea;
        const [w, h] = win.getSize();
        win.setPosition(d.x + d.width - w - 24, d.y + d.height - h - 24);
      } catch { /* ignore */ }
      return;
    }
    if (!opts.mini) {
      mainContents = win.webContents;
      try {
        pushEvent("app-ready", { version: "0.1.0" });
        // Crash recovery: unfinalized recordings from a previous session.
        const unfinished = listRecordings(RECORDING_DIR()).filter((r) => !r.finalized && r.sizeBytes > 0);
        if (unfinished.length) {
          pushEvent("dc-recovery", {
            items: unfinished.slice(0, 5).map((r) => ({ webmPath: r.webmPath, sizeBytes: r.sizeBytes })),
          });
        }
      } catch { /* ignore */ }
    }
  });

  if (opts.mini) {
    if (isDev) {
      void win.loadURL(`${DEV_URL}/mini.html`);
    } else {
      void win.loadFile(path.join(projectPath("dist"), "mini.html"));
    }
    return win;
  }
  if (isDev) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadFile(path.join(projectPath("dist"), "index.html"));
  }
  return win;
}

/** Grant a requested display source to the page's getDisplayMedia call. */
function onDisplayMediaRequest(
  _request: Electron.DisplayMediaRequestHandlerHandlerRequest,
  callback: (streams: Electron.Streams) => void,
): void {
  desktopCapturer.getSources({ types: ["screen", "window"] }).then((sources) => {
    const wanted = captureSourceId ? sources.find((s) => s.id === captureSourceId) : undefined;
    const src = wanted ?? sources.find((s) => s.id.startsWith("screen")) ?? sources[0];
    if (!src) { callback({}); return; }
    callback({ video: { id: src.id, name: src.name }, audio: "loopback" });
  }).catch((e) => {
    console.error("[directorcam] display media grant failed", e);
    callback({});
  });
}

function registerIpc(): void {
  session.defaultSession.setDisplayMediaRequestHandler(onDisplayMediaRequest, {
    useSystemPicker: false,
  });

  // Generic command invoke (page -> main).
  ipcMain.handle("dc-invoke", async (_event, cmd: string, args: Record<string, unknown>) => {
    try {
      return { ok: true, data: await handleInvoke(cmd, args ?? {}) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // Low-level call bus (used by bridge `call`).
  ipcMain.handle("dc-call", async (_event, type: string, payload: unknown) => {
    try {
      return { ok: true, data: handleCall(type, payload) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle("dc-listen", async (_event, event: string) => {
    void event;
    return true;
  });

  // Source enumeration (with thumbnails for the picker UI).
  ipcMain.handle("list_sources", async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 320, height: 180 },
      });
      return sources.map((s) => ({
        id: s.id,
        name: s.name || (s.id.startsWith("screen") ? "屏幕" : "窗口"),
        kind: s.id.startsWith("screen") ? "screen" : "window",
        displayId: s.display_id || "",
        thumb: s.thumbnail?.toDataURL?.() ?? "",
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle("__dc_window_exists", async (_e, data: { label?: string }) => {
    if (data?.label === "mini") return !!miniWindow;
    return false;
  });

  ipcMain.handle("__dc_window_property", async (_e, data: { label?: string; prop: string }) => {
    const win = data?.label === "mini" ? miniWindow : mainWindow;
    if (!win) return false;
    switch (data.prop) {
      case "isMinimized":
        return win.isMinimized();
      case "isVisible":
        return win.isVisible();
      default:
        return false;
    }
  });

  ipcMain.handle("__dc_window_control", async (_e, data) => {
    const label = data?.label as string | undefined;
    if (label === "mini" && !miniWindow) {
      miniWindow = makeWindow({ mini: true });
    }
    const target = label === "mini" ? miniWindow : mainWindow;
    if (!target) return;
    switch (data?.action) {
      case "minimize": target.minimize(); break;
      case "unminimize":
        // The window may have been hidden (minimize → preventDefault + hide),
        // in which case unminimize() alone is a no-op — always show + focus.
        try { (target as unknown as { unminimize(): void }).unminimize(); } catch { /* ignore */ }
        try { target.show(); } catch { /* ignore */ }
        try { target.focus(); } catch { /* ignore */ }
        break;
      case "hide": target.hide(); break;
      case "show": target.show(); break;
      case "focus": target.focus(); break;
      case "close": target.close(); break;
      case "alwaysOnTop": target.setAlwaysOnTop(!!data.v); break;
      case "position": target.setPosition(Number(data.x), Number(data.y)); break;
      case "size": target.setSize(Number(data.w), Number(data.h)); break;
      default: break;
    }
  });

  ipcMain.handle("__dc_open_dialog", async (_e, opts) => {
    const props: ("openDirectory" | "openFile" | "multiSelections")[] = [];
    if (opts?.directory) props.push("openDirectory");
    else props.push("openFile");
    if (opts?.multiple) props.push("multiSelections");
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, { properties: props })
      : await dialog.showOpenDialog({ properties: props });
    return res ?? null;
  });

  ipcMain.handle("__dc_save_dialog", async (_e, opts) => {
    void opts;
    const res = mainWindow
      ? await dialog.showSaveDialog(mainWindow)
      : await dialog.showSaveDialog({});
    return res ?? null;
  });

  ipcMain.handle("__dc_save_recording", async (_e, data: { bytes: Uint8Array | number[] }) => {
    const raw = data?.bytes ?? [];
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const isTA = raw instanceof Uint8Array;
    const head = Array.from(bytes.slice(0, 8)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    console.log(`[__dc_save_recording] len=${bytes.length} isTypedArray=${isTA} head=[${head}] type=${raw?.constructor?.name}`);
    const savedPath = saveRecordingBytes(RECORDING_DIR(), bytes);
    if (savedPath) {
      lastSavedRecording = savedPath;
      try { saveSettings({ last_saved_recording: savedPath }); } catch { /* ignore */ }
    }
    return savedPath;
  });

  ipcMain.handle("__dc_shell_open", async (_e, data: { path?: string }) => {
    if (data?.path) shellOpen(data.path);
    return true;
  });
  ipcMain.handle("__dc_shell_open_url", async (_e, data: { url?: string }) => {
    if (data?.url) shellOpen(data.url);
    return true;
  });
  ipcMain.handle("__dc_reveal_in_dir", async (_e, data: { path?: string }) => {
    if (data?.path) revealInDir(data.path);
    return true;
  });

  // Desktop overlay: forward frames/state drawn by the page to the overlay window.
  ipcMain.on("dc-overlay-send", (_e, payload) => {
    // Attach the current cursor (overlay-local DIP coords) so the overlay window
    // can always position the lens/ring, independent of the page's push cadence.
    let p = payload;
    if (p && typeof p === "object") {
      // Incremental highlighter-ink events bypass the 33ms frame cadence so
      // the pen trail tracks the cursor with no perceptible lag.
      if ("penEvent" in (p as Record<string, unknown>)) {
        showOverlay(true);
        pushOverlay("ov-pen", (p as Record<string, unknown>).penEvent);
        return;
      }
      try {
        const pos = screen.getCursorScreenPoint();
        const bounds = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow.getBounds() : null;
        const local = bounds ? { x: pos.x - bounds.x, y: pos.y - bounds.y } : { x: pos.x, y: pos.y };
        p = { ...(p as Record<string, unknown>), cursor: local };
      } catch { /* ignore */ }
    }
    showOverlay(true);
    pushOverlay("ov-frame", p);
  });
  ipcMain.on("dc-overlay-clear", () => {
    showOverlay(!(overlayFFOn || overlayPrivacyDrawOn || !!overlayPrivacyBoxRect));
    pushOverlay("ov-clear", null);
  });

  // dcmedia:///<url-encoded path segments> — streams local recordings for review.
  protocol.handle("dcmedia", (request) => {
    try {
      const u = new URL(request.url);
      let p = decodeURIComponent(u.pathname || "").replace(/^\/+/, "");
      if (!/^[a-zA-Z]:\//.test(p)) {
        const host = decodeURIComponent(u.hostname || "");
        if (host) p = host + ":/" + p;
      }
      if (!/^[a-zA-Z]:\//.test(p)) return new Response("bad path", { status: 400 });
      return net.fetch("file:///" + p);
    } catch (e) {
      console.error("[directorcam] dcmedia fetch failed", e);
      return new Response("not found", { status: 404 });
    }
  });

  // Region-recording selection session: overlay draw UI -> normalized rect.
  // Runs standalone (not tied to a privacy mark); the rect goes to the
  // recording session as a global crop for the export pass.
  // Mini console commands (from the pure-stage companion window).
  ipcMain.handle("mini_command", async (_e, data: { cmd?: string }) => {
    const cmd = String(data?.cmd || "");
    switch (cmd) {
      case "toggle-recording":
      case "cycle-audio":
      case "toggle-webcam":
        pushEvent("dc-hotkey", { cmd });
        return true;
      case "open-source-picker":
        pushEvent("dc-mini-open-source-picker", null);
        try { mainWindow?.show(); } catch { /* ignore */ }
        return true;
      case "minimize":
        try { miniWindow?.hide(); } catch { /* ignore */ }
        return true;
      case "close-studio":
        pushEvent("dc-hotkey", { cmd: "toggle-studio" });
        try { miniWindow?.hide(); } catch { /* ignore */ }
        return true;
      case "query-state":
        pushEvent("dc-mini-query-state", null);
        return true;
      default:
        return false;
    }
  });

  // Relay state pushes from the main renderer to the mini console.
  ipcMain.handle("mini_state_update", (_e, state: unknown) => {
    try {
      miniContents?.send("dc-event", { event: "mini-state", data: state });
    } catch { /* ignore */ }
    return true;
  });
  ipcMain.handle("mini_time_update", (_e, t: { elapsed_ms: number }) => {
    try {
      miniContents?.send("dc-event", { event: "mini-time", data: t });
    } catch { /* ignore */ }
    return true;
  });

  // Click shield: page notifies when annotation effects are on/off so the
  // overlay stops being click-through while drawing/zooming is active.
  ipcMain.on("dc-overlay-shield", (_e, on: unknown) => {
    overlayShield = !!on;
    applyOverlayMouseMode();
    console.log(`[directorcam] overlay click shield ${overlayShield ? "ON" : "OFF"}`);
  });
}

function handleCall(type: string, payload: unknown): unknown {
  void payload;
  switch (type) {
    case "emit":
      void type;
      return true;
    default:
      return null;
  }
}

async function handleInvoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "check_ffmpeg":
      return !!resolveFfmpeg();

    case "list_sources": {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 320, height: 180 },
        });
        return sources.map((sc) => ({
          id: sc.id,
          name: sc.name || (sc.id.startsWith("screen") ? "屏幕" : "窗口"),
          kind: sc.id.startsWith("screen") ? "screen" : "window",
          displayId: sc.display_id || "",
          thumb: sc.thumbnail?.toDataURL?.() ?? "",
        }));
      } catch {
        return [];
      }
    }

    // --- Capture source selection -------------------------------------------
    case "set_capture_source":
      captureSourceId = args.sourceId ? String(args.sourceId) : null;
      return true;

    case "get_source_rect": {
      // On-screen DIP rect (primary-origin) of the captured source, for
      // mapping overlay-drawn privacy boxes into the captured frame.
      const sourceId = String(args.sourceId || "");
      if (!sourceId) return null;
      if (sourceId.startsWith("window:")) {
        const m = sourceId.match(/^window:(\d+):/);
        if (!m || !getWindowRect) return null;
        const r: Record<string, number> = { left: 0, top: 0, right: 0, bottom: 0 };
        try {
          if (!getWindowRect(Number(m[1]), r)) return null;
          const tl = screen.screenToDipPoint({ x: r.left, y: r.top });
          const br = screen.screenToDipPoint({ x: r.right, y: r.bottom });
          return { x: tl.x, y: tl.y, w: Math.max(1, br.x - tl.x), h: Math.max(1, br.y - tl.y) };
        } catch { return null; }
      }
      // Screen source: match via display_id recorded in list_sources.
      const displayId = String(args.displayId || "");
      const displays = screen.getAllDisplays();
      const disp = displays.find((d) => d.id.toString() === displayId) ?? screen.getPrimaryDisplay();
      return { x: disp.bounds.x, y: disp.bounds.y, w: disp.bounds.width, h: disp.bounds.height };
    }

    case "save_screenshot": {
      const bytes = args.bytes instanceof Uint8Array ? args.bytes : new Uint8Array(args.bytes as number[]);
      try {
        ensureDir(RECORDING_DIR());
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const p = path.join(RECORDING_DIR(),
          `DirectorCam_Shot_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`);
        fs.writeFileSync(p, Buffer.from(bytes));
        return p;
      } catch (e) {
        console.error("[directorcam] screenshot save failed", e);
        return null;
      }
    }

    case "get_shortcut_config":
      return getShortcutsConfig();

    case "get_shortcut_failures":
      return globallyFailedShortcuts;

    case "list_system_fonts":
      return listSystemFonts();

    case "update_shortcut_config":
      if (args.cfg) saveSettings({ shortcuts: args.cfg });
      return true;

    case "set_audio_source":
      saveSettings({ audio_source: args.source });
      return true;

    case "check_license": {
      const lic = loadSettings().license as Record<string, unknown> | undefined;
      return {
        tier: lic?.tier ?? "Free",
        key_hash: lic?.key_hash ?? "",
        activated_at: lic?.activated_at ?? "",
        source: lic?.source ?? "store",
      };
    }

    case "activate_license": {
      const key = String(args.key || "").replace(/\s/g, "").toUpperCase();
      if (key.length >= 16) {
        saveSettings({
          license: {
            tier: "Pro",
            key_hash: simpleHash(key),
            activated_at: new Date().toISOString(),
            source: "License_key",
          },
        });
        return true;
      }
      throw new Error("Invalid license key");
    }

    case "open_folder":
      // No path -> open the recordings library directory.
      shellOpen(String(args.path || RECORDING_DIR()));
      return true;

    case "probe_media_duration": {
      const ffmpeg = resolveFfmpeg();
      if (!ffmpeg) return 0;
      return await probeDurationMs(ffmpeg, String(args.path || "")) / 1000;
    }

    // --- Recording session (incremental disk flush) -------------------------
    case "recording_begin": {
      if (activeSession) activeSession.end(0);
      resetOverlayPrivacyState();
      let lowDisk = false;
      let freeGb = 0;
      try {
        const st = await fs.promises.statfs(RECORDING_DIR());
        freeGb = (st.bavail * st.bsize) / 1024 ** 3;
        lowDisk = freeGb < 2;
      } catch { /* statfs unavailable */ }
      activeSession = RecordingSession.begin(RECORDING_DIR());
      lastSavedRecording = activeSession.paths.webmPath;
      try { saveSettings({ last_saved_recording: lastSavedRecording }); } catch { /* ignore */ }
      return { webmPath: activeSession.paths.webmPath, editsPath: activeSession.paths.editsPath, lowDisk, freeGb };
    }
    case "recording_chunk": {
      const bytes = args.bytes instanceof Uint8Array ? args.bytes : new Uint8Array(args.bytes as number[]);
      activeSession?.appendChunk(bytes);
      return true;
    }
    case "recording_set_region": {
      const rect = args.rect as { x: number; y: number; w: number; h: number } | null;
      if (activeSession && rect) {
        activeSession.setRecordRegion(rect);
      }
      return true;
    }
    case "recording_mousesamples": {
      const samples = Array.isArray(args.samples) ? args.samples : [];
      activeSession?.appendMouseSamples(samples as { tMs: number; x: number; y: number }[]);
      return true;
    }
    case "recording_camsamples": {
      const samples = Array.isArray(args.samples) ? args.samples : [];
      for (const s of samples) {
        const o = s as { tMs?: number; x?: number; y?: number; w?: number; h?: number };
        if (typeof o.tMs === "number") {
          activeSession?.appendCameraSample({
            tMs: o.tMs, x: o.x ?? 0.5, y: o.y ?? 0.5, w: o.w ?? 1, h: o.h ?? 1,
          });
        }
      }
      return true;
    }
    case "recording_end": {
      const durationMs = Number(args.durationMs) || 0;
      const mouse = Array.isArray(args.mouseSamples) ? args.mouseSamples : [];
      activeSession?.appendMouseSamples(mouse as { tMs: number; x: number; y: number }[]);
      if (args.regionRect && typeof args.regionRect === "object") {
        activeSession?.setRecordRegion(args.regionRect as { x: number; y: number; w: number; h: number });
      }
      if (activeSession) {
        const sess = activeSession;
        // Privacy masks must stay on the film until the last frame of the
        // recording: the region is private from its first (backtraced)
        // appearance and stays hidden even after the F6 box was closed.
        // Nail every mask's endMs to the record duration so the saved EDL
        // (and the review strip) reflects the real coverage.
        const recMs = Math.max(0, Math.round(durationMs));
        sess.getEdl().edits.forEach((e, i) => {
          if (e.type === "mask") {
            sess.updateEdit(i, { ...e, endMs: Math.max(e.endMs, recMs), pending: false });
          }
        });
        // Privacy trim: cut [content's first appearance → box-drawn moment].
        // The demo footage before the content appeared stays; the leak window
        // (content visible but not yet covered) is removed instead of tracked.
        sess.getEdl().edits.forEach((e) => {
          if (e.type === "mask") {
            const cut = privacyCutForMask(e);
            if (cut) sess.addEdit(cut);
          }
        });
        openMaskIndex = null;
        const p = sess.paths.webmPath;
        sess.end(durationMs);
        activeSession = null;
        lastSavedRecording = p;
        return p;
      }
      return lastSavedRecording ?? "";
    }

    // --- EDL (marks) --------------------------------------------------------
    case "edl_append": {
      if (!activeSession) throw new Error("no active recording session");
      const res = activeSession.addEdit(args.edit as EditEntry);
      return res;
    }
    case "edl_get": {
      const p = String(args.path || "");
      if (p) return readEdlFile(sidecarPaths(p).editsPath);
      return activeSession?.getEdl() ?? emptyEdl();
    }
    case "edl_update": {
      if (!activeSession) throw new Error("no active recording session");
      return activeSession.updateEdit(Number(args.index), args.edit as EditEntry);
    }
    case "recording_mark_finalized": {
      const p = String(args.webmPath || "");
      if (!p) return false;
      const edl = readEdlFile(sidecarPaths(p).editsPath);
      writeEdlFile(sidecarPaths(p).editsPath, { ...edl, finalized: true });
      return true;
    }
    case "list_recordings":
      return listRecordings(RECORDING_DIR());

    // --- Privacy mask + backtrace -------------------------------------------
    case "privacy_mark_start": {
      if (!activeSession) throw new Error("no active recording session");
      const region = args.region as { x: number; y: number; w: number; h: number };
      const fallbackStart = Math.max(0, Number(args.fallbackStartMs) || 0);
      const nowMs = Math.max(fallbackStart, Number(args.nowMs) || fallbackStart);
      const edit: EditEntry = {
        type: "mask",
        startMs: fallbackStart,
        endMs: Math.max(nowMs, fallbackStart + 1000),
        region,
        style: "black",
        muteAudio: false,
        startSource: "grace",
        pending: true,
        drawnAtMs: nowMs,
        refRegionHash: String(args.refRegionHash || ""),
        refPixels: String(args.refPixels || ""),
      };
      const { index } = activeSession.addEdit(edit);
      openMaskIndex = index;
      // Fire the content backtrace; on success the mask start moves to the
      // first appearance of the masked content on its page. The update is
      // applied even after the box has been ended — the mark stays valid.
      const session = activeSession;
      const ffmpeg = resolveFfmpeg();
      if (ffmpeg) {
        void scanBacktrace({
          webmPath: session.paths.webmPath,
          ffmpegPath: ffmpeg,
          region,
          refRegionHash: String(args.refRegionHash || ""),
          refFrameHash: String(args.refFrameHash || ""),
          refPixels: String(args.refPixels || ""),
          fps: 4,
          dynamicEntranceMs: 6000,
          // The reference is sampled from full-res live pixels but the scan
          // compares at 256x144 — the resampling drops every similarity, so the
          // strict defaults routinely false-negative a legitimate first match
          // (measured ~0.75 on genuinely present content). The authoritative
          // start is re-derived at export time with a scan-pipeline reference;
          // this early ladder only needs to not miss (over-covering is fine).
          thresholds: { region: 0.65, frame: 0.55 },
        }).then((res) => {
          if (session !== activeSession) return;
          const cur = session.getEdl().edits[index];
          if (!cur || cur.type !== "mask") return;
          if (res.startMs !== null) {
            session.updateEdit(index, { ...cur, startMs: res.startMs, startSource: res.method ?? "grace", pending: false });
            pushEvent("dc-privacy-backtrace", { index, startMs: res.startMs, method: res.method });
          } else {
            // Ladder failed: keep the grace-window start, clear "pending".
            session.updateEdit(index, { ...cur, pending: false, startSource: "grace" });
            pushEvent("dc-privacy-backtrace", { index, startMs: cur.startMs, method: "grace" });
          }
        }).catch((e) => console.warn("[directorcam] backtrace failed:", e));
      }
      return { index };
    }
    case "privacy_mark_end": {
      if (!activeSession || openMaskIndex === null) return false;
      const nowMs = Number(args.nowMs) || 0;
      const edl = activeSession.getEdl();
      const cur = edl.edits[openMaskIndex];
      if (cur && cur.type === "mask") {
        const endMs = Math.max(cur.startMs + 500, nowMs);
        activeSession.updateEdit(openMaskIndex, { ...cur, endMs, pending: false });
      }
      openMaskIndex = null;
      return true;
    }

    // --- Overlay control for marks -------------------------------------------
    case "overlay_ff":
      overlayFFOn = !!args.on;
      if (overlayFFOn) showOverlay(true);
      pushOverlay("ov-ff", { on: !!args.on });
      return true;
    case "overlay_privacy_draw":
      overlayPrivacyDrawOn = !!args.on;
      overlayPrivacyHint = "拖拽框选需要遮挡的区域（F6 取消）";
      // Ensure the window exists and is visible BEFORE pushing — the very first
      // F6 press used to push into a not-yet-created overlay and drop the event.
      if (overlayPrivacyDrawOn) showOverlay(true);
      pushOverlay("ov-privacy-draw", { on: overlayPrivacyDrawOn, hint: overlayPrivacyHint });
      if (args.on) {
        overlayShield = true; // overlay swallows the mouse during the drag
        applyOverlayMouseMode();
      } else {
        overlayShield = false;
        applyOverlayMouseMode();
      }
      console.log(`[directorcam] privacy draw ${overlayPrivacyDrawOn ? "ON" : "off"} (overlay ${overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible() ? "visible" : "hidden"})`);
      return true;
    case "overlay_privacy_box":
      overlayPrivacyBoxRect = (args.rect as { x: number; y: number; w: number; h: number } | null) ?? null;
      if (overlayPrivacyBoxRect) showOverlay(true);
      pushOverlay("ov-privacy-box", { rect: overlayPrivacyBoxRect });
      return true;
    // From the OVERLAY window: a mask rectangle was dragged.
    case "privacy_region_selected": {
      const rect = args.rect as { x: number; y: number; w: number; h: number } | null;
      overlayPrivacyDrawOn = false;
      overlayShield = false;
      applyOverlayMouseMode();
      pushOverlay("ov-privacy-draw", { on: false });
      if (regionSelectWait) {
        // Region-recording selection in progress.
        const wait = regionSelectWait;
        regionSelectWait = null;
        wait(rect);
        return true;
      }
      if (rect) {
        pushEvent("dc-privacy-region", { rect });
      }
      return true;
    }

    // --- App settings blob (renderer settings persistence) -------------------
    case "save_app_settings":
      saveSettings({ app_settings_v2: args.settings ?? {} });
      return true;
    case "get_app_settings":
      return (loadSettings().app_settings_v2 as Record<string, unknown>) ?? {};

    case "stop_recording":
    case "save_recording": {
      if (!lastSavedRecording) {
        const s = loadSettings().last_saved_recording;
        if (typeof s === "string" && s) lastSavedRecording = s;
      }
      return lastSavedRecording ?? "";
    }
    case "start_recording":
    case "rewind_recording":
    case "trigger_effect":
      // Recording / effects handled in the page.
      return true;

    case "toggle_studio_mode": {
      const on = args.on === true;
      if (on) {
        // Hide desktop icons once; a second enable does not toggle again.
        if (!studioIconsHidden) studioIconsHidden = toggleDesktopIcons();
        // Solid-color backdrop pinned to the bottom of the z-order.
        if (!studioBackdrop) {
          const disp = screen.getPrimaryDisplay();
          studioBackdrop = new BrowserWindow({
            x: disp.bounds.x, y: disp.bounds.y,
            width: disp.bounds.width, height: disp.bounds.height,
            frame: false, resizable: false, movable: false,
            skipTaskbar: true, focusable: false, hasShadow: false,
            show: true,
            backgroundColor: String(args.backgroundColor || "#0a0a0f"),
          });
          studioBackdrop.setIgnoreMouseEvents(true, { forward: false });
          try {
            const handle = studioBackdrop.getNativeWindowHandle() as Buffer;
            sendWindowToBottom(handle);
          } catch { /* best-effort */ }
        }
        // Companion mini console pinned bottom-right: recording/source/audio/
        // webcam controls stay reachable while the desktop is in pure mode.
        try {
          if (!miniWindow || miniWindow.isDestroyed()) miniWindow = makeWindow({ mini: true });
          miniWindow.showInactive();
        } catch { /* ignore */ }
        return true;
      }
      if (studioIconsHidden) {
        studioIconsHidden = !toggleDesktopIcons();
      }
      if (studioBackdrop) {
        try { studioBackdrop.destroy(); } catch { /* ignore */ }
        studioBackdrop = null;
      }
      try { miniWindow?.hide(); } catch { /* ignore */ }
      return true;
    }

    case "region_select_session": {
      showOverlay(true);
      pushOverlay("ov-privacy-draw", {
        on: true,
        mode: "region",
        hint: "拖拽框选录制区域 — 松开即开始录制（ESC 取消）",
      });
      overlayShield = true;
      applyOverlayMouseMode();
      return await new Promise((resolve) => {
        regionSelectWait = resolve;
        setTimeout(() => {
          if (regionSelectWait === resolve) {
            regionSelectWait = null;
            overlayShield = false;
            applyOverlayMouseMode();
            pushOverlay("ov-privacy-draw", { on: false });
            resolve(null);
          }
        }, 120000);
      });
    }

    // Renderer asked to abort the pending region selection (second F9).
    case "region_select_cancel": {
      if (regionSelectWait) {
        const wait = regionSelectWait;
        regionSelectWait = null;
        overlayShield = false;
        applyOverlayMouseMode();
        pushOverlay("ov-privacy-draw", { on: false });
        wait(null);
      }
      return true;
    }

    case "check_whisper": {
      const bin = resolveWhisper(projectPath(), "");
      return !!bin;
    }

    // --- Chapter / metadata generation (needs a prior subtitle export) ------
    case "generate_chapters": {
      const { generateVideoMetadata, metadataToMarkdown } = await import("./subtitles/chapters");
      const transcriptPath = String(args.transcriptPath || "");
      if (!fs.existsSync(transcriptPath)) return null;
      const segments = (JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as { startMs: number; text: string }[])
        .filter((s) => typeof s.startMs === "number" && typeof s.text === "string");
      const llm = (args.llm ?? {}) as Record<string, unknown>;
      const meta = await generateVideoMetadata(
        segments,
        {
          enabled: llm.enabled === true,
          baseUrl: String(llm.baseUrl || ""),
          apiKey: String(llm.apiKey || ""),
          model: String(llm.model || ""),
          glossary: String(args.glossary || ""),
        },
        fetch,
      );
      if (!meta) return null;
      const mdPath = transcriptPath.replace(/\.transcript\.json$/, "") + "_info.md";
      try { fs.writeFileSync(mdPath, metadataToMarkdown(meta), "utf8"); } catch { /* ignore */ }
      return { ...meta, markdownPath: mdPath };
    }

    case "export_video":
      return runExport(args);

    default:
      return null;
  }
}

/** Probe a media file duration from ffmpeg's stderr banner (fast, no ffprobe). */
function probeDurationMs(ffmpegPath: string, file: string): Promise<number> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(ffmpegPath, ["-i", file], { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 15000);
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve(0); });
    child.on("close", () => {
      clearTimeout(timer);
      const m = out.match(/Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d+)/);
      if (m) {
        resolve(((+m[1] * 3600) + (+m[2] * 60) + +m[3]) * 1000 + Number(`0.${m[4]}`) * 1000);
      } else resolve(0);
    });
  });
}

async function runExport(args: Record<string, unknown>): Promise<string> {
  const ffmpeg = resolveFfmpeg();
  let inputPath = String(args.inputPath || "");
  let outputPath = String(args.outputPath || "").replace(
    /%USERPROFILE%/g,
    () => process.env.USERPROFILE || os.homedir(),
  );
  const config = (args.config ?? {}) as Record<string, unknown>;

  if (!inputPath && lastSavedRecording) inputPath = lastSavedRecording;
  if (!ffmpeg) return "FFmpeg not found.";
  if (!inputPath || !outputPath) return "Missing paths.";
  if (!fs.existsSync(inputPath)) return `Input not found: ${inputPath}`;
  try { ensureDir(path.dirname(outputPath)); } catch { return `Cannot write to: ${outputPath}`; }

  // EDL sidecar (marks recorded during the session), if any.
  const sidecars = sidecarPaths(inputPath);
  const edl: EdlFile = readEdlFile(sidecars.editsPath);
  const durationMs = edl.durationMs ?? (await probeDurationMs(ffmpeg, inputPath)) ?? 0;

  // Mouse trajectory for the export-time follow-focus render.
  let mouseTrack: { tMs: number; x: number; y: number }[] = [];
  if (config.zoom_enabled === true) {
    try {
      const { parseMouseTrack } = await import("../src/recording/focusZoom");
      mouseTrack = parseMouseTrack(fs.readFileSync(sidecars.mouseTrackPath, "utf8"));
    } catch { /* no sidecar */ }
  }

  const style = (config.subtitle_style ?? {}) as Record<string, unknown>;
  const llm = (config.llm ?? {}) as Record<string, unknown>;
  // Windows CJK-capable font for the brand outro card (best first).
  const brandFont = ["msyh.ttc", "msyhbd.ttc", "simhei.ttf", "segoeui.ttf"]
    .map((f) => path.join(process.env.WINDIR || "C:\Windows", "Fonts", f))
    .find((f) => fs.existsSync(f)) ?? "";
  const brandZh = config.brand_lang !== "en";
  // Brand logo: the bundled EaseRec mark is part of the outro design
  // (dev: src/assets; packaged: extraResources/brand). If missing, text-only card.
  const brandLogo = (() => {
    for (const cand of [
      projectPath("src-tauri", "brand", "easerec-logo.png"),
      projectPath("src", "assets", "easerec.png"),
      process.resourcesPath
        ? path.join(process.resourcesPath, "brand", "easerec-logo.png")
        : "",
    ]) {
      if (cand && fs.existsSync(cand)) return cand;
    }
    return "";
  })();
  const settings: ExportSettings = {
    fps: Number(config.fps) || 60,
    zoomEnabled: config.zoom_enabled === true,
    zoomLevel: Number(config.zoom_level) || 1.5,
    brandOutro: config.brand_outro !== false, // default ON
    brandFontPath: brandFont,
    brandLogoPath: brandLogo,
    brandTitle: brandZh ? "简录 EaseRec" : "EaseRec",
    brandSlogan: brandZh ? "简录，让知识输出回归纯粹。" : "Recording, simplified.",
    trimSilence: !!config.trim_silence && Number(config.silence_threshold_s) > 0,
    silenceThresholdS: Number(config.silence_threshold_s) || 0,
    loudnorm: config.loudnorm === true,
    subtitles: config.burn_subtitles === true,
    subtitleStyle: {
      fontFamily: String(style.fontFamily || "Microsoft YaHei"),
      fontSize: Number(style.fontSize) || 28,
      color: String(style.color || "#FFFFFF"),
      outlineColor: String(style.outlineColor || "#000000"),
      outlineWidth: Number(style.outlineWidth) || 2,
      position: (style.position === "top" || style.position === "middle" ? style.position : "bottom") as "bottom" | "middle" | "top",
      marginV: Number(style.marginV) || 40,
    },
    llmEnabled: llm.enabled === true,
    glossary: String(config.glossary || ""),
    introEnabled: config.intro_enabled === true && !!config.intro_path,
    introPath: String(config.intro_path || ""),
    introDurationS: Number(config.intro_duration_s) || 3,
    outroEnabled: config.outro_enabled === true && !!config.outro_path,
    outroPath: String(config.outro_path || ""),
    outroDurationS: Number(config.outro_duration_s) || 3,
    vertical: config.vertical_export === true,
    sourceWidth: Number(config.source_width) || 3840,
    sourceHeight: Number(config.source_height) || 2160,
    verticalWidth: 1080,
    verticalHeight: 1920,
  };

  const result = await runExportPipeline({
    inputPath,
    outputPath,
    outDir: path.dirname(outputPath),
    edl,
    durationMs,
    settings: { ...settings, zoomEnabled: config.zoom_enabled === true },
    mouseTrack,
    recordRegion: (() => {
      try {
        return JSON.parse(fs.readFileSync(sidecars.regionPath, "utf8")) as { x: number; y: number; w: number; h: number };
      } catch { return null; }
    })(),
    camTrackPath: sidecarPaths(inputPath).camTrackPath,
    llmConfig: {
      enabled: llm.enabled === true,
      baseUrl: String(llm.baseUrl || ""),
      apiKey: String(llm.apiKey || ""),
      model: String(llm.model || ""),
      glossary: String(config.glossary || ""),
    },
    ctx: {
      ffmpegPath: ffmpeg,
      projectDir: projectPath(),
      whisperModelPath: String(config.modelPath || ""),
      asrLanguage: String(config.asrLanguage || "zh"),
      onProgress: (label, index, total) => {
        pushEvent("dc-export-progress", { label, index, total });
      },
    },
  });
  if (result.startsWith("Saved to:")) {
    lastSavedRecording = outputPath;
    try { saveSettings({ last_saved_recording: outputPath }); } catch { /* ignore */ }
  }
  if (config.zoom_enabled === true && mouseTrack.length <= 5) {
    return result + "\n⚠ 该录像没有鼠标轨迹（旧版本录制或未开启跟焦），本次导出未渲染智能跟焦。";
  }
  return result;
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return "h" + h.toString(16);
}

function defaultShortcuts() {
  return {
    toggle_recording: { key: "F9", modifiers: [] },
    toggle_studio: { key: "F1", modifiers: [] },
    toggle_ff: { key: "F4", modifiers: [] },
    toggle_privacy: { key: "F6", modifiers: [] },
    toggle_privacy_cut: { key: "F6", modifiers: ["SHIFT"] },
    toggle_pause: { key: "F10", modifiers: [] },
    toggle_magnifier: { key: "Digit1", modifiers: ["CONTROL"] },
    toggle_step_marker: { key: "Digit2", modifiers: ["CONTROL"] },
    toggle_highlighter: { key: "Digit3", modifiers: ["CONTROL"] },
    toggle_ripple: { key: "KeyR", modifiers: ["CONTROL"] },
    zoom_cycle: { key: "Equal", modifiers: [] },
    zoom_level_1: { key: "Digit4", modifiers: ["CONTROL"] },
    zoom_level_2: { key: "Digit5", modifiers: ["CONTROL"] },
    zoom_level_3: { key: "Digit6", modifiers: ["CONTROL"] },
  };
}

function mapKeyCode(code: string): string {
  // Electron accelerator key names differ from KeyboardEvent.code
  // Digits: Digit0→0..Digit9→9, Letters: KeyA→A..KeyZ→Z
  if (/^Digit(\d)$/.test(code)) return code.slice(5);
  if (/^Key([A-Z])$/.test(code)) return code.slice(3);
  const map: Record<string, string> = {
    Equal: "=", Minus: "-", BracketLeft: "[", BracketRight: "]",
    Backslash: "\\", Semicolon: "'", Quote: '"', Backquote: "`",
    Comma: ",", Period: ".", Slash: "/", Space: "Space",
    Enter: "Return", Escape: "Escape", Tab: "Tab",
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Delete: "Delete", Insert: "Insert", Home: "Home", End: "End",
    PageUp: "PageUp", PageDown: "PageDown",
    NumpadAdd: "numadd", NumpadSubtract: "numsub", NumpadMultiply: "nummult",
    NumpadDivide: "numdiv", NumpadEnter: "numenter",
    Backspace: "Backspace", CapsLock: "CapsLock",
  };
  return map[code] ?? code;
}

function buildAccelerator(key: string, modifiers: string[]): string {
  const mappedKey = mapKeyCode(key);
  const prefix = modifiers.map((m) => {
    const ml = m.toLowerCase();
    if (ml === "control" || ml === "ctrl") return "Ctrl";
    if (ml === "alt") return "Alt";
    if (ml === "shift") return "Shift";
    if (ml === "meta" || ml === "command" || ml === "super") return "Super";
    return m.charAt(0).toUpperCase() + m.slice(1).toLowerCase();
  }).join("+");
  return prefix ? prefix + "+" + mappedKey : mappedKey;
}

/** Read the current shortcut config item for a hotkey command. */
function getShortcutsConfig(): Record<string, { key: string; modifiers?: string[] }> {
  // Merge over the defaults: saved configs from older versions miss newer
  // commands (F4/F6/…), which must fall back to their default keys.
  const saved = loadSettings().shortcuts;
  return { ...defaultShortcuts(), ...((saved && typeof saved === "object") ? saved : {}) } as Record<string, { key: string; modifiers?: string[] }>;
}

function shortcutItemFor(cmd: string): { key: string; modifiers?: string[] } | undefined {
  const cfg = getShortcutsConfig();
  switch (cmd) {
    case "toggle-recording": return cfg.toggle_recording;
    case "toggle-studio": return cfg.toggle_studio;
    case "toggle-ff": return cfg.toggle_ff;
    case "toggle-privacy": return cfg.toggle_privacy;
    case "toggle-privacy-cut": return cfg.toggle_privacy_cut;
    case "toggle-pause": return cfg.toggle_pause;
    case "toggle-magnifier": return cfg.toggle_magnifier;
    case "toggle-step-marker": return cfg.toggle_step_marker;
    case "toggle-highlighter": return cfg.toggle_highlighter;
    case "toggle-ripple": return cfg.toggle_ripple;
    case "zoom-cycle": return cfg.zoom_cycle;
    case "zoom-level-1": return cfg.zoom_level_1;
    case "zoom-level-2": return cfg.zoom_level_2;
    case "zoom-level-3": return cfg.zoom_level_3;
    default: return undefined;
  }
}

/** Keys that users type (digits, letters, Space, Tab, "=", …) must never be
 *  registered as bare GLOBAL accelerators: on Windows such hotkeys get
 *  swallowed for every process while often never delivering (the bug that
 *  killed bare digits 1/2/3 — they could not be typed anywhere and the in-window
 *  keydown fallback never saw them). Modifier-free F-keys stay global.
 *  Bare typing keys are served by the page keydown fallback (app focused)
 *  and the koffi hook (unfocused digits/Tab). */
function isTypeableBareKey(key: string, modifiers: string[] | undefined): boolean {
  if (modifiers && modifiers.length > 0) return false;
  if (/^F\d{1,2}$/.test(key)) return false;
  if (/^(ScrollLock|Pause|PrintScreen|Insert|Delete|NumLock)$/.test(key)) return false;
  return true;
}

// Retrying global-shortcut registration. Electron's GlobalShortcutListener is
// initially still warming up right after `app.ready`: the exact same build can
// register every accelerator on one launch and reject them all on the next.
// Retrying the still-missing ones with a short backoff makes hotkeys reliable;
// accelerators that are genuinely grabbed by another app (e.g. bare F1/F2/F3)
// keep failing and fall back to the page's in-window keydown handler.
let globalShortcutRetry: ReturnType<typeof setTimeout> | null = null;
let globalShortcutTries = 0;

function registerGlobalShortcuts(): void {
  type ShortcutItem = { key: string; modifiers?: string[] };
  const cfg: Record<string, ShortcutItem> = getShortcutsConfig();
  const bindings: { cmd: string; accel: string }[] = [
    { cmd: "toggle-recording", accel: buildAccelerator(cfg.toggle_recording.key, cfg.toggle_recording.modifiers ?? []) },
    { cmd: "toggle-studio", accel: buildAccelerator(cfg.toggle_studio.key, cfg.toggle_studio.modifiers ?? []) },
    { cmd: "toggle-ff", accel: buildAccelerator(cfg.toggle_ff.key, cfg.toggle_ff.modifiers ?? []) },
    { cmd: "toggle-privacy", accel: buildAccelerator(cfg.toggle_privacy.key, cfg.toggle_privacy.modifiers ?? []) },
    { cmd: "toggle-privacy-cut", accel: buildAccelerator(cfg.toggle_privacy_cut.key, cfg.toggle_privacy_cut.modifiers ?? []) },
    { cmd: "toggle-pause", accel: buildAccelerator(cfg.toggle_pause.key, cfg.toggle_pause.modifiers ?? []) },
    { cmd: "toggle-magnifier", accel: buildAccelerator(cfg.toggle_magnifier.key, cfg.toggle_magnifier.modifiers ?? []) },
    { cmd: "toggle-step-marker", accel: buildAccelerator(cfg.toggle_step_marker.key, cfg.toggle_step_marker.modifiers ?? []) },
    { cmd: "toggle-highlighter", accel: buildAccelerator(cfg.toggle_highlighter.key, cfg.toggle_highlighter.modifiers ?? []) },
    { cmd: "toggle-ripple", accel: buildAccelerator(cfg.toggle_ripple.key, cfg.toggle_ripple.modifiers ?? []) },
    { cmd: "zoom-cycle", accel: buildAccelerator(cfg.zoom_cycle.key, cfg.zoom_cycle.modifiers ?? []) },
    { cmd: "zoom-level-1", accel: buildAccelerator(cfg.zoom_level_1.key, cfg.zoom_level_1.modifiers ?? []) },
    { cmd: "zoom-level-2", accel: buildAccelerator(cfg.zoom_level_2.key, cfg.zoom_level_2.modifiers ?? []) },
    { cmd: "zoom-level-3", accel: buildAccelerator(cfg.zoom_level_3.key, cfg.zoom_level_3.modifiers ?? []) },
  ];
  const failedCmds = new Set<string>();
  const vkFor = (key: string): number | null => {
    const m = key.match(/^F(\d{1,2})$/);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= 1 && n <= 12 ? VK_FKEY_BASE + n - 1 : null;
  };
  const rebuildKoffiWatch = (): void => {
    koffiHotkeyWatch = bindings
      .filter((b) => failedCmds.has(b.cmd))
      .map((b) => {
        const item = shortcutItemFor(b.cmd);
        const vk = item ? vkFor(item.key) : null;
        const mods = item?.modifiers ?? [];
        return vk !== null && mods.length === 0 ? { cmd: b.cmd, accel: b.accel, vk } : null;
      })
      .filter((x): x is { cmd: string; accel: string; vk: number } => x !== null);
  };

  const attempt = (): void => {
    for (const b of bindings) {
      const cmd = b.cmd;
      if (!failedCmds.has(cmd)) continue; // already confirmed OK
      if (globalShortcut.isRegistered(b.accel)) {
        failedCmds.delete(cmd);
        continue;
      }
      let ok = false;
      try {
        ok = globalShortcut.register(b.accel, () => pushEvent("dc-hotkey", { cmd }));
      } catch { ok = false; }
      if (!ok) console.log(`[directorcam] shortcut STILL FAILED: ${b.accel} -> ${cmd}`);
    }
    if (failedCmds.size === 0) {
      globallyFailedShortcuts = [];
      koffiHotkeyWatch = [];
      console.log("[directorcam] all global shortcuts registered (retries hit none)");
      pushEvent("dc-hotkey-status", { failed: [] });
      return;
    }
    globalShortcutTries++;
    rebuildKoffiWatch();
    if (globalShortcutTries < 25) {
      try {
        if (globalShortcutRetry) clearTimeout(globalShortcutRetry);
        globalShortcutRetry = setTimeout(attempt, 700);
        console.log(`[directorcam] retrying ${failedCmds.size} global shortcut(s) (try ${globalShortcutTries})`);
      } catch { /* ignore */ }
    } else {
      globallyFailedShortcuts = [...failedCmds];
      pushEvent("dc-hotkey-status", { failed: [...failedCmds] });
    }
  };

  // First pass: register every accelerator (the listener may still be warming
  // up, so some come back false this round).
  for (const b of bindings) {
    const it = shortcutItemFor(b.cmd);
    if (it && isTypeableBareKey(it.key, it.modifiers)) {
      // Never register bare typing keys as global hotkeys (they would swallow
      // the key system-wide and may still never deliver). The in-window keydown
      // fallback serves the focused case; the koffi hook covers unfocused.
      console.log(`[directorcam] shortcut PAGE-FALLBACK (not global): ${b.accel} -> ${b.cmd}`);
      continue;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(b.accel, () => pushEvent("dc-hotkey", { cmd: b.cmd }));
    } catch { ok = false; }
    console.log(`[directorcam] shortcut ${ok ? "OK" : "FAILED"}: ${b.accel} -> ${b.cmd}`);
    if (!ok) failedCmds.add(b.cmd);
  }
  if (failedCmds.size === 0) {
    globallyFailedShortcuts = [];
    koffiHotkeyWatch = [];
    pushEvent("dc-hotkey-status", { failed: [] });
    return;
  }
  globallyFailedShortcuts = [...failedCmds];
  rebuildKoffiWatch();
  globalShortcutTries = 1;
  try {
    if (globalShortcutRetry) clearTimeout(globalShortcutRetry);
    globalShortcutRetry = setTimeout(attempt, 700);
    console.log(`[directorcam] scheduling retry for ${failedCmds.size} global shortcut(s)`);
  } catch { /* ignore */ }
}

let cursorPoller: ReturnType<typeof setInterval> | null = null;
const fkeyWatchState = new Map<string, boolean>();

function startCursorPolling(): void {
  if (cursorPoller) return;
  let lastX = 0, lastY = 0;
  let lmbDown = false, escapeDown = false;
  let digit1Down = false, digit2Down = false, digit3Down = false;
  let tabDown = false;
  let lastClickAt = 0;
  cursorPoller = setInterval(() => {
    try {
      const pos = screen.getCursorScreenPoint();
      if (pos.x !== lastX || pos.y !== lastY) {
        lastX = pos.x; lastY = pos.y;
        pushEvent("dc-cursor", { x: pos.x, y: pos.y });
        // Also feed the desktop overlay (convert to overlay-local DIP coords).
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          const b = overlayWindow.getBounds();
          pushOverlay("dc-cursor", { x: pos.x - b.x, y: pos.y - b.y });
        }
      }

      // Global click / ESC detection (works when the app is minimized/focused).
      if (getAsyncKeyState) {
        const now = Date.now();
        const lmb = (getAsyncKeyState(VK_LBUTTON) & 0x8000) !== 0;
        if (lmb && !lmbDown && now - lastClickAt > 60) {
          lastClickAt = now;
          pushEvent("dc-mouse-click", { x: pos.x, y: pos.y });
        }
        // LMB press/release edges → feed the renderer (highlighter pen path)
        // and the overlay window (it re-renders the pen strokes).
        if (lmb !== lmbDown) {
          pushEvent(lmb ? "dc-mouse-down" : "dc-mouse-up", { x: pos.x, y: pos.y });
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            const b = overlayWindow.getBounds();
            pushOverlay(lmb ? "dc-mouse-down" : "dc-mouse-up", { x: pos.x - b.x, y: pos.y - b.y });
          }
        }
        lmbDown = lmb;

        const esc = (getAsyncKeyState(VK_ESCAPE) & 0x8000) !== 0;
        if (esc && !escapeDown) {
          pushEvent("dc-key", { key: "Escape" });
          // Cancel a pending region-recording selection.
          if (regionSelectWait) {
            const wait = regionSelectWait;
            regionSelectWait = null;
            overlayShield = false;
            applyOverlayMouseMode();
            pushOverlay("ov-privacy-draw", { on: false });
            wait(null);
          }
        }
        escapeDown = esc;

        // Bare Digit1/2/3 zoom levels. globalShortcut registration for
        // modifier-less digit accelerators is flaky on Windows: it can report
        // OK yet never deliver (while still swallowing the key system-wide), so
        // the page keydown fallback never sees it either. Detect the digit
        // rising edges with the same GetAsyncKeyState hook as LMB/ESC and fire
        // the hotkey directly — the 250ms debounce in the renderer dedupes any
        // duplicate from a global shortcut that *did* deliver. Same for a bare
        // Tab mapped to zoom_cycle.
        const modsHeld = ((getAsyncKeyState(VK_CONTROL) & 0x8000) !== 0) ||
          ((getAsyncKeyState(VK_MENU) & 0x8000) !== 0) ||
          ((getAsyncKeyState(VK_SHIFT) & 0x8000) !== 0);
        if (!modsHeld) {
          const d1 = (getAsyncKeyState(VK_1) & 0x8000) !== 0;
          if (d1 && !digit1Down) pushEvent("dc-hotkey", { cmd: "zoom-level-1" });
          digit1Down = d1;
          const d2 = (getAsyncKeyState(VK_2) & 0x8000) !== 0;
          if (d2 && !digit2Down) pushEvent("dc-hotkey", { cmd: "zoom-level-2" });
          digit2Down = d2;
          const d3 = (getAsyncKeyState(VK_3) & 0x8000) !== 0;
          if (d3 && !digit3Down) pushEvent("dc-hotkey", { cmd: "zoom-level-3" });
          digit3Down = d3;
          const tab = (getAsyncKeyState(VK_TAB) & 0x8000) !== 0;
          if (tab && !tabDown) pushEvent("dc-hotkey", { cmd: "zoom-cycle" });
          tabDown = tab;
        } else {
          digit1Down = false;
          digit2Down = false;
          digit3Down = false;
          tabDown = false;
        }

        // Bare F-key fallback: keys whose global registration failed (another
        // app grabbed them) are edge-polled here so they still work system-wide.
        for (const w of koffiHotkeyWatch) {
          const down = (getAsyncKeyState(w.vk) & 0x8000) !== 0;
          const prev = fkeyWatchState.get(w.cmd) ?? false;
          if (down && !prev && now - lastClickAt > 60) {
            pushEvent("dc-hotkey", { cmd: w.cmd });
          }
          fkeyWatchState.set(w.cmd, down);
        }
      }
    } catch { /* ignore */ }
  }, 16);
}

app.whenReady().then(() => {
  ensureDir(RECORDING_DIR());
  registerIpc();
  mainWindow = makeWindow();
  registerGlobalShortcuts();
  startCursorPolling();
  // System tray: minimize hides here, tray click restores the main window.
  ensureTray();
});

// Review playback needs <video> access to local recording files; the page may
// run from the dev server (http origin), so stream them over a custom scheme.
protocol.registerSchemesAsPrivileged([
  { scheme: "dcmedia", privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } },
]);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  appQuitting = true;
  if (tray && !tray.isDestroyed()) { try { tray.destroy(); } catch { /* ignore */ } }
  tray = null;
  if (cursorPoller) { clearInterval(cursorPoller); cursorPoller = null; }
  if (globalShortcutRetry) { clearTimeout(globalShortcutRetry); globalShortcutRetry = null; }
  globalShortcut.unregisterAll();
});