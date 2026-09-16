import { useEffect } from "react";
import type { ReactNode } from "react";
import { useStore } from "../../store";
import { useLang } from "../../lib/useLang";
import i18n from "../../i18n";

/**
 * Hub shell — title bar with the two top-level views (工作台 / 素材库),
 * theme + language toggles. The chrome is intentionally minimal.
 */
export function HubShell({ children }: { children: ReactNode }) {
  const ui = useStore((s) => s.ui);
  const setUi = useStore((s) => s.setUi);
  const setLanguage = useStore((s) => s.setLanguage);
  const L = useLang();

  useEffect(() => {
    document.documentElement.dataset.theme = ui.theme;
  }, [ui.theme]);

  const toggleTheme = () => setUi({ theme: ui.theme === "dark" ? "light" : "dark" });
  const toggleLang = () => {
    const next = useStore.getState().current === "en" ? "zh-CN" : "en";
    setLanguage(next);
    void i18n.changeLanguage(next);
  };

  return (
    <div style={styles.shell}>
      <div style={styles.titleBar}>
        <div style={styles.brand}>
          <span style={styles.logo}>🎬</span>
          <span style={styles.title}>{L("简录", "EaseRec")}</span>
          <span style={styles.tagline} title={L("简录，让知识输出回归纯粹。", "EaseRec — recording, simplified.")}>{L("让知识输出回归纯粹", "Recording, simplified")}</span>
        </div>
        <div style={styles.tabs}>
          <button
            style={{ ...styles.tab, ...(ui.view === "studio" ? styles.tabOn : {}) }}
            onClick={() => setUi({ view: "studio", reviewPath: null })}
            title={L("回到工作台 = 实时预览（回放只属于刚停的那一条）", "Studio = live preview; playback belongs to the just-stopped take only")}
          >
            🎬 {L("工作台", "Studio")}
          </button>
          <button
            style={{ ...styles.tab, ...(ui.view === "library" ? styles.tabOn : {}) }}
            onClick={() => setUi({ view: "library" })}
          >
            📚 {L("素材库", "Library")}
          </button>
        </div>
        <div style={styles.right}>
          <button style={styles.miniToggle} onClick={toggleLang} title="Language">{useStore.getState().current === "en" ? "中" : "EN"}</button>
          <button style={styles.miniToggle} onClick={toggleTheme} title={L("浅色 / 深色", "Light / dark")}>
            {ui.theme === "dark" ? "☀️" : "🌙"}
          </button>
          <span style={styles.version}>v0.2</span>
        </div>
      </div>
      <div style={styles.body}>{children}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: { height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-primary)", color: "var(--text-primary)" },
  titleBar: {
    height: 40, display: "flex", alignItems: "center",
    padding: "0 12px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-subtle)",
    WebkitAppRegion: "drag", gap: 16,
  } as React.CSSProperties,
  brand: { display: "flex", alignItems: "center", gap: 8, minWidth: 190 },
  logo: { fontSize: 15 },
  title: { fontSize: 13, fontWeight: 700, color: "var(--text-primary)", letterSpacing: 0.5 },
  tagline: { fontSize: 10, color: "var(--accent)", padding: "1px 8px", borderRadius: 8, border: "1px solid var(--border-accent)", background: "rgba(99,130,255,0.08)" },
  tabs: { display: "flex", gap: 4, flex: 1, justifyContent: "center", WebkitAppRegion: "no-drag" } as React.CSSProperties,
  tab: {
    padding: "5px 16px", borderRadius: "var(--radius-sm)", fontSize: 12, fontWeight: 600,
    background: "transparent", color: "var(--text-secondary)", border: "1px solid transparent",
    cursor: "pointer", transition: "all 0.15s",
  },
  tabOn: { background: "var(--bg-tertiary)", color: "var(--text-primary)", borderColor: "var(--border-default)" },
  right: { display: "flex", alignItems: "center", gap: 8, minWidth: 190, justifyContent: "flex-end", WebkitAppRegion: "no-drag" } as React.CSSProperties,
  miniToggle: {
    fontSize: 11, padding: "3px 9px", borderRadius: "var(--radius-sm)",
    background: "var(--bg-tertiary)", color: "var(--text-secondary)",
    border: "1px solid var(--border-default)", cursor: "pointer",
  },
  version: { fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" },
  body: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
};
