import type { EditEntry } from "../recording/edl";

export interface RecordingState {
  isRecording: boolean;
  isPaused: boolean;
  elapsedMs: number;
  /** Accumulated duration of finished pauses (display-only adjustment). */
  pausedMs: number;
  fps: number;
  audioSource: "system" | "mic" | "both";
  loopbackActive: boolean;
  micActive: boolean;
  /** Selected capture source (null = primary screen auto). */
  sourceId: string | null;
  sourceName: string;
  sourceKind: "screen" | "window" | null;
  /** Region-recording mode: box-select an area of the primary screen. */
  regionMode: boolean;
  /** Selected region (normalized to the primary screen) in regionMode. */
  regionRect: { x: number; y: number; w: number; h: number } | null;
}

export interface StudioState {
  isActive: boolean;
  targetWindowId: number | null;
  blurStrength: number;
  backgroundColor: string;
}

export interface EffectsState {
  activeMagnifier: boolean;
  activeHighlighter: boolean;
  /** True while "step marker mode" is on: every mouse click places the next marker. */
  stepModeActive: boolean;
  stepMarkers: { id: number; x: number; y: number }[];
  rippleEnabled: boolean;
  /** Magnifier zoom level (1..3), set with digits 1/2/3 while active. */
  lensLevel: number;
  /** Step-marker background color id ("red" | "yellow" | "blue"), digits 1/2/3. */
  stepMarkerColor: "red" | "yellow" | "blue";
  /** Highlighter pen style level (1..3), digits 1/2/3 while active. */
  penLevel: number;
  /** Record-start countdown: remaining seconds (3/2/1) or null when idle. While
   *  set, the desktop overlay renders the big center-screen number and clicks
   *  stay unblocked. Cleared by the start flow the moment recording begins. */
  countdown: number | null;
}

export interface WebcamState {
  enabled: boolean;
  cameraIndex: number;
  position: "bottom_right" | "bottom_left" | "top_right" | "top_left" | "custom";
  customX: number;
  customY: number;
  sizeRatio: number;
  shape: "circle" | "rounded_rect" | "rect";
  borderColor: string;
  borderWidth: number;
  cornerRadius: number;
}

export interface SubtitleStyleState {
  fontFamily: string;
  fontSize: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  position: "bottom" | "middle" | "top";
  marginV: number;
}

export interface LlmConfigState {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Floating teleprompter config. `visible` is transient session state — the
 *  prompter must never pop open by itself at launch. */
export interface TeleprompterState {
  /** Full script text (paragraphs separated by blank lines). */
  text: string;
  /** Prompt font size in px (10..200). */
  fontSize: number;
  /** Auto-scroll speed in px/s (0 = manual only). */
  speed: number;
  /** Whether the floating window is currently shown. */
  visible: boolean;
}

export interface SettingsState {
  fps: number;
  resolution: { width: number; height: number };
  bitrateMbps: number;
  /** Export-time follow-focus render from the mouse track. */
  zoomEnabled: boolean;
  /** Zoom level of the follow-focus render. */
  zoomLevel: number;
  outputDir: string;
  modelPath: string;
  subtitleEnabled: boolean;
  /** Subtitle look (ASS style fields), user-configurable. */
  subtitleStyle: SubtitleStyleState;
  /** Online LLM correction of the ASR transcript. */
  llm: LlmConfigState;
  /** Newline/comma separated hot words injected into whisper + LLM prompts. */
  glossary: string;
  /** ASR language hint ("zh" | "en" | "auto"). */
  asrLanguage: string;
  /** EBU R128 loudness normalization on export. */
  loudnorm: boolean;
  /** Also produce a 9:16 vertical reframe on export. */
  verticalExport: boolean;
  /** Privacy backtrace fallback window (seconds) when matching fails. */
  privacyGraceS: number;
  /** Fast-forward compression window (seconds). */
  ffTargetSecs: [number, number];
  /** Append the built-in brand outro clip on export (default on). */
  brandOutro: boolean;
  /** Intro/outro attached on the film strip (exported as final concat parts). */
  introPath: string;
  introDurationS: number;
  outroPath: string;
  outroDurationS: number;
  /** Play the bundled chime when an export finishes successfully. */
  successSound: boolean;
  /** Floating teleprompter script + look (see TeleprompterState). */
  teleprompter: TeleprompterState;
}

/** Hub UI state. theme persists; the rest is transient. */
export interface UiState {
  theme: "dark" | "light";
  view: "studio" | "library";
  /** Export drawer open. */
  exportOpen: boolean;
  /** Settings dialog open. */
  settingsOpen: boolean;
  /** Source picker open. */
  sourcePickerOpen: boolean;
  /** Review playback path (last finished recording). */
  reviewPath: string | null;
  /** Seek request for the review player (ms in main film time). */
  seekRequest: { ms: number; nonce: number } | null;
}

/** Marks accumulated during the current/last recording (EDL mirror for UI). */
export interface MarksState {
  /** Normalized EDL entries of the active (or last opened) recording. */
  edits: EditEntry[];
  /** Source path of the recording the edits belong to. */
  webmPath: string | null;
  /** Open privacy mask (box currently on screen). */
  activePrivacy: { startMs: number } | null;
  /** Open whole-cut privacy range (Shift+F6). */
  activePrivacyCut: { startMs: number } | null;
  /** Open pause range (F10) — auto-cut at export. */
  activePause: { startMs: number } | null;
  /** Open fast-forward range (F4). */
  activeFF: { startMs: number } | null;
  /** True while the overlay is in box-draw mode. */
  privacyDrawing: boolean;
  /** Latest user-facing feedback line (toasts in the status bar). */
  feedback: string | null;
  /** Unfinalized recordings found at startup (crash recovery). */
  recoverable: { webmPath: string; sizeBytes: number }[];
  /** Bumped at every recording start — identity for "the latest take", so UI
   *  guidance (next-step CTA) can re-arm per take without a file path. */
  takeId: number;
}
