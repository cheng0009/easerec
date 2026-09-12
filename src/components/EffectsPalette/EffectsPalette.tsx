import { useStore } from "../../store";
import { useTranslation } from "react-i18next";
import { sectionHeader, card } from "../../styles/components/panel";

function EffectButton({ label, shortcut, active, onToggle }: { label: string; shortcut: string; active: boolean; onToggle: () => void }) {
  return (
    <button style={{ ...btnStyle, borderColor: active ? "var(--border-accent)" : "var(--border-default)", background: active ? "rgba(99,130,255,0.12)" : "var(--bg-primary)" }} onClick={onToggle}>
      <span style={{ fontSize: 13 }}>{label}</span><kbd style={kbd}>{shortcut}</kbd>
    </button>
  );
}

export function EffectsPalette() {
  const { t } = useTranslation();
  const effects = useStore((s) => s.effects);
  const setEffects = useStore((s) => s.setEffects);

  return (
    <div style={card}>
      <h3 style={sectionHeader}>{t("effects.title")}</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <EffectButton label={t("effects.magnifier")} shortcut="Alt+Q" active={effects.activeMagnifier}
          onToggle={() => setEffects({ activeMagnifier: !effects.activeMagnifier })} />
        <EffectButton label={t("effects.highlighter")} shortcut="Alt+E" active={effects.activeHighlighter}
          onToggle={() => setEffects({ activeHighlighter: !effects.activeHighlighter })} />
        <EffectButton label={t("effects.stepMarker")} shortcut="Alt+W" active={effects.stepModeActive}
          onToggle={() => {
            const willEnable = !effects.stepModeActive;
            setEffects({ stepModeActive: willEnable, stepMarkers: willEnable ? [] : effects.stepMarkers });
          }} />
        <EffectButton label={t("effects.ripple")} shortcut="Alt+R" active={effects.rippleEnabled}
          onToggle={() => setEffects({ rippleEnabled: !effects.rippleEnabled })} />
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.7 }}>
        {effects.stepModeActive ? t("effects.stepHint") : `${t("effects.escHint")}（Alt+Q/W/E）`}
      </div>
    </div>
  );
}
const btnStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderRadius: "var(--radius-sm)", background: "var(--bg-primary)", border: "1px solid", cursor: "pointer", fontSize: 12, transition: "border-color 0.2s" };
const kbd: React.CSSProperties = { fontSize: 10, padding: "2px 6px", borderRadius: 3, background: "var(--bg-tertiary)", border: "1px solid var(--border-default)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" };