import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./styles/global.css";
import { useStore } from "./store";
import { tauriInvoke } from "./lib/tauri";

const SPLASH_MIN_MS = 4000;

// Mirror the main-process license state (source of truth: userData license
// file) so drawers/filmstrip can gate Pro features.
void tauriInvoke<{ licensed: boolean; info?: { licenseNo: string; issuedAtIso: string } }>("get_license_status")
  .then((s) => {
    useStore.getState().setLicense({
      pro: !!s?.licensed,
      licenseNo: s?.info?.licenseNo ?? null,
      issuedAtIso: s?.info?.issuedAtIso ?? null,
    });
  })
  .catch(() => { /* stay unlicensed-looking until first IPC works */ });

function removeSplash() {
  const splash = document.getElementById("splash");
  if (!splash || splash.dataset.exit) return;
  splash.dataset.exit = "1";
  splash.classList.add("splash-exit");
  splash.addEventListener("animationend", () => splash.remove(), { once: true });
  // Safety net: never let the overlay linger invisible on a slow timer.
  window.setTimeout(() => splash.remove(), 700);
}

function dismissSplash() {
  const elapsed = performance.now();
  const wait = Math.max(0, SPLASH_MIN_MS - elapsed);
  window.setTimeout(() => removeSplash(), wait);
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

// Only remove the splash once the animation has had time to play through
// (measured from page load), so the intro reads as intended even when the
// React bundle mounts quickly.
window.addEventListener("load", dismissSplash);
window.setTimeout(dismissSplash, 60);