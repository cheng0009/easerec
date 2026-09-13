import { create } from "zustand";
import type { RecordingState, StudioState, EffectsState, WebcamState, SettingsState, MarksState, SubtitleStyleState, LlmConfigState, UiState } from "./types";
import { DEFAULT_RECORDING_CONFIG } from "../lib/constants";

export interface LanguageState {
  current: string;
  setLanguage: (lang: string) => void;
}

interface AppStore extends LanguageState {
  recording: RecordingState;
  setRecording: (partial: Partial<RecordingState>) => void;
  studio: StudioState;
  setStudio: (partial: Partial<StudioState>) => void;
  effects: EffectsState;
  setEffects: (partial: Partial<EffectsState>) => void;
  webcam: WebcamState;
  setWebcam: (partial: Partial<WebcamState>) => void;
  settings: SettingsState;
  setSettings: (partial: Partial<SettingsState>) => void;
  marks: MarksState;
  setMarks: (partial: Partial<MarksState>) => void;
  ui: UiState;
  setUi: (partial: Partial<UiState>) => void;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyleState = {
  fontFamily: "Microsoft YaHei",
  fontSize: 28,
  color: "#FFFFFF",
  outlineColor: "#000000",
  outlineWidth: 2,
  position: "bottom",
  marginV: 40,
};

export const DEFAULT_LLM: LlmConfigState = {
  enabled: false,
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
};

function loadSettingsFromStorage(): Partial<SettingsState> {
  try {
    const s = localStorage.getItem("dc_app_settings_v3");
    return s ? (JSON.parse(s) as Partial<SettingsState>) : {};
  } catch { return {}; }
}

export const useStore = create<AppStore>((set) => ({
  // Language
  current: (() => {
    try { return localStorage.getItem("directorcam_lang") ?? "zh-CN"; }
    catch { return "zh-CN"; }
  })(),
  setLanguage: (lang) => {
    try { localStorage.setItem("directorcam_lang", lang); } catch {}
    set({ current: lang });
  },

  // Recording
  recording: { isRecording: false, isPaused: false, elapsedMs: 0, pausedMs: 0, fps: 0, audioSource: "both", loopbackActive: false, micActive: false, sourceId: null, sourceName: "主显示器", sourceKind: null, regionMode: false, regionRect: null },
  setRecording: (partial) => set((s) => ({ recording: { ...s.recording, ...partial } })),

  // Studio
  studio: { isActive: false, targetWindowId: null, blurStrength: 20, backgroundColor: "#16130f" },
  setStudio: (partial) => set((s) => ({ studio: { ...s.studio, ...partial } })),

  // Effects
  effects: { activeMagnifier: false, activeHighlighter: false, stepModeActive: false, stepMarkers: [], rippleEnabled: false, lensLevel: 2, stepMarkerColor: "blue", penLevel: 1, countdown: null },
  setEffects: (partial) => set((s) => ({ effects: { ...s.effects, ...partial } })),

  // Webcam
  webcam: { enabled: false, cameraIndex: 0, position: "bottom_right", customX: 0.85, customY: 0.85, sizeRatio: 0.20, shape: "circle", borderColor: "#ffffff", borderWidth: 2, cornerRadius: 0.15 },
  setWebcam: (partial) => set((s) => ({ webcam: { ...s.webcam, ...partial } })),

  // Settings
  settings: {
    ...DEFAULT_RECORDING_CONFIG,
    outputDir: "",
    modelPath: "",
    silenceThresholdS: 1.5,
    subtitleEnabled: false,
    subtitleStyle: DEFAULT_SUBTITLE_STYLE,
    llm: DEFAULT_LLM,
    glossary: "",
    asrLanguage: "zh",
    loudnorm: false,
    verticalExport: false,
    privacyGraceS: 8,
    ffTargetSecs: [3, 5],
    introPath: "",
    introDurationS: 3,
    outroPath: "",
    outroDurationS: 3,
    successSound: true,
    ...loadSettingsFromStorage(),
    // Brand outro is a fixed, non-user-editable feature (see ExportDrawer) —
    // ignore any stale persisted value that would silently skip it.
    brandOutro: true,
  },
  setSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),

  // Marks (EDL mirror)
  marks: {
    edits: [],
    webmPath: null,
    activePrivacy: null,
    activePrivacyCut: null,
    activePause: null,
    activeFF: null,
    privacyDrawing: false,
    feedback: null,
    recoverable: [],
  },
  setMarks: (partial) => set((s) => ({ marks: { ...s.marks, ...partial } })),

  // Hub UI
  ui: {
    theme: (() => {
      try { return (localStorage.getItem("directorcam_theme") as "dark" | "light") ?? "dark"; }
      catch { return "dark" as const; }
    })(),
    view: "studio", exportOpen: false, settingsOpen: false, sourcePickerOpen: false, reviewPath: null, seekRequest: null,
  },
  setUi: (partial) => {
    if (partial.theme) {
      try { localStorage.setItem("directorcam_theme", partial.theme); } catch {}
      document.documentElement.dataset.theme = partial.theme;
    }
    set((s) => ({ ui: { ...s.ui, ...partial } }));
  },
}));
