import { useState } from "react";
import { useStore } from "../../store";
import { getDirector } from "../../recording/director";
import { sectionHeader, card } from "../../styles/components/panel";
import { useLang } from "../../lib/useLang";

const positions = [
  { value: "bottom_right", label: "↘" },
  { value: "bottom_left", label: "↙" },
  { value: "top_right", label: "↗" },
  { value: "top_left", label: "↖" },
  { value: "custom", label: "⊞" },
];

const shapes = [
  { value: "rounded_rect", label: "▢" },
  { value: "circle", label: "○" },
  { value: "rect", label: "▭" },
];

export function WebcamPanel() {
  const L = useLang();
  const wc = useStore((s) => s.webcam);
  const setWebcam = useStore((s) => s.setWebcam);
  const [error, setError] = useState<string | null>(null);

  const toggleWebcam = async () => {
    const enabled = !wc.enabled;
    setError(null);
    setWebcam({ enabled });
    try {
      if (enabled) {
        const ok = await getDirector().recorder.startWebcam();
        if (!ok) {
          setWebcam({ enabled: false });
          setError(L("无法打开摄像头（可能被其他程序占用）", "Camera unavailable (may be in use)"));
        }
      } else {
        await getDirector().recorder.stopWebcam();
      }
    } catch (e) {
      setWebcam({ enabled: false });
      setError(L("摄像头启动失败", "Failed to start camera"));
      console.error(e);
    }
  };

  const updateConfig = (partial: Partial<typeof wc>) => {
    // The composer reads the store live — config changes apply immediately.
    setWebcam(partial);
  };

  return (
    <div style={card}>
      <h3 style={sectionHeader}>{L("摄像头", "Camera")}</h3>
      <button
        style={{ ...toggleBtn, background: wc.enabled ? "var(--accent)" : "var(--bg-tertiary)" }}
        onClick={toggleWebcam}
      >
        {wc.enabled ? L("● 关闭摄像头", "● Stop camera") : L("○ 开启摄像头", "○ Start camera")}
      </button>

      {error && <div style={{ fontSize: 10, color: "var(--accent-danger)", marginBottom: 6 }}>{error}</div>}

      {/* Position */}
      <div style={row}>
        <span style={label}>{L("位置", "Position")}</span>
        <select
          style={selectStyle}
          value={wc.position}
          onChange={(e) => updateConfig({ position: e.target.value as typeof wc.position })}
        >
          {positions.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      {/* Size */}
      <div style={row}>
        <span style={label}>{L("大小", "Size")} {Math.round(wc.sizeRatio * 100)}%</span>
        <input
          type="range"
          min={8}
          max={35}
          value={Math.round(wc.sizeRatio * 100)}
          style={slider}
          onChange={(e) => updateConfig({ sizeRatio: Number(e.target.value) / 100 })}
        />
      </div>

      {/* Shape */}
      <div style={row}>
        <span style={label}>{L("形状", "Shape")}</span>
        <select
          style={selectStyle}
          value={wc.shape}
          onChange={(e) => updateConfig({ shape: e.target.value as typeof wc.shape })}
        >
          {shapes.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Border color */}
      <div style={row}>
        <span style={label}>{L("边框", "Border")}</span>
        <input
          type="color"
          value={wc.borderColor}
          style={{ width: 32, height: 24, border: "none", borderRadius: 4, cursor: "pointer" }}
          onChange={(e) => updateConfig({ borderColor: e.target.value })}
        />
        <input
          type="range"
          min={0}
          max={8}
          value={wc.borderWidth}
          style={{ ...slider, width: 60 }}
          onChange={(e) => updateConfig({ borderWidth: Number(e.target.value) })}
        />
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{wc.borderWidth}px</span>
      </div>
    </div>
  );
}

const toggleBtn: React.CSSProperties = { width: "100%", padding: "8px 12px", borderRadius: "var(--radius-sm)", fontSize: 13, fontWeight: 600, color: "var(--text-primary)", transition: "background 0.2s", marginBottom: 8 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, gap: 6 };
const label: React.CSSProperties = { fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap" };
const slider: React.CSSProperties = { width: 80, accentColor: "var(--accent)" };
const selectStyle: React.CSSProperties = { fontSize: 11, padding: "3px 6px", borderRadius: "var(--radius-sm)", background: "var(--bg-tertiary)", color: "var(--text-primary)", border: "1px solid var(--border-default)" };
