/**
 * Dev runner: starts the Vite dev server, waits for it, then launches Electron
 * pointing at it. Requires `npm run build:electron` first.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const electronBin = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const mainCjs = path.join(root, "dist-electron", "main.cjs");

if (!fs.existsSync(electronBin)) {
  console.error("[dev] electron binary not found. Run `npm install` first.");
  process.exit(1);
}
if (!fs.existsSync(mainCjs)) {
  console.error("[dev] dist-electron/main.cjs not found. Run `npm run build:electron` first.");
  process.exit(1);
}

const PORT = 5173;
const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");

const vite = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});

vite.stdout?.on("data", (d) => process.stdout.write(`[vite] ${d}`));
vite.stderr?.on("data", (d) => process.stderr.write(`[vite-err] ${d}`));

function waitForServer(timeoutMs = 30000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tryConnect = () => {
      const req = http.get(`http://localhost:${PORT}`, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) { resolve(false); }
        else { setTimeout(tryConnect, 500); }
      });
      req.on("timeout", () => { req.destroy(); tryConnect(); });
    };
    tryConnect();
  });
}

waitForServer().then((ok) => {
  if (!ok) {
    console.error("[dev] Vite dev server did not start in time.");
    vite.kill();
    process.exit(1);
  }
  console.log(`[dev] Starting Electron against http://localhost:${PORT}`);

  const electron = spawn(electronBin, [root, "--dev", "--no-sandbox"], {
    cwd: root,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: `http://localhost:${PORT}`,
    },
    stdio: "inherit",
  });

  const shutdown = () => {
    electron.kill();
    vite.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  vite.on("exit", () => { electron.kill(); process.exit(0); });
  electron.on("exit", (code) => {
    console.log(`[dev] Electron exited (${code}).`);
    vite.kill();
    process.exit(code ?? 0);
  });
});
