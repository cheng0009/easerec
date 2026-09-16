import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./styles/global.css";

const SPLASH_MIN_MS = 4000;

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