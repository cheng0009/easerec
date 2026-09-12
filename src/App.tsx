import { StudioPanel } from "./components/StudioPanel/StudioPanel";
import { EffectsPalette } from "./components/EffectsPalette/EffectsPalette";
import { WebcamPanel } from "./components/WebcamPanel/WebcamPanel";
import { PreviewStage } from "./components/PreviewStage/PreviewStage";
import { FilmStrip } from "./components/FilmStrip/FilmStrip";
import { ControlBar } from "./components/ControlBar/ControlBar";
import { StatusBar } from "./components/layout/StatusBar";
import { ExportDrawer } from "./components/ExportDrawer/ExportDrawer";
import { LibraryView } from "./components/LibraryView/LibraryView";
import { SettingsDialog } from "./components/SettingsDialog/SettingsDialog";
import { SourcePicker } from "./components/SourcePicker/SourcePicker";
import { HubShell } from "./components/layout/HubShell";
import { useStore } from "./store";
import { useRecorderState } from "./hooks/useRecorderState";
import { useRecordingMiniWindow } from "./hooks/useRecordingMiniWindow";
import { installDirectorController } from "./recording/startup";

function StudioView() {
  const recording = useStore((s) => s.recording);
  return (
    <div style={styles.studio}>
      <div style={{ ...styles.left, opacity: recording.isRecording ? 0.55 : 1, pointerEvents: recording.isRecording ? "none" : "auto" } as React.CSSProperties}>
        <StudioPanel />
        <EffectsPalette />
        <WebcamPanel />
      </div>
      <div style={styles.center}>
        <PreviewStage />
        <FilmStrip />
        <ControlBar />
      </div>
    </div>
  );
}

export default function App() {
  installDirectorController();
  useRecorderState();
  useRecordingMiniWindow();
  const view = useStore((s) => s.ui.view);

  return (
    <HubShell>
      <canvas id="recording-canvas" style={{ display: "none" }} />
      {view === "studio" ? <StudioView /> : <LibraryView />}
      <StatusBar />
      <ExportDrawer />
      <SettingsDialog />
      <SourcePicker />
    </HubShell>
  );
}

const styles: Record<string, React.CSSProperties> = {
  studio: { flex: 1, display: "flex", gap: 10, padding: 10, overflow: "hidden" },
  left: {
    width: 232, display: "flex", flexDirection: "column", gap: 8, flexShrink: 0,
    overflow: "hidden", transition: "opacity 0.25s",
  },
  center: { flex: 1, display: "flex", flexDirection: "column", gap: 8, overflow: "hidden", minWidth: 0 },
};
