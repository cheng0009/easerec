import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const bridge = (file: string) => resolve(__dirname, "src/bridge", file);

import fs from "node:fs";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: "copy-static-pages",
      closeBundle() {
        // Static windows (mini console / focus renderer) load from dist;
        // vendor the muxer so no node_modules access is needed in production.
        fs.mkdirSync("dist/vendor", { recursive: true });
        fs.copyFileSync("node_modules/mp4-muxer/build/mp4-muxer.mjs", "dist/vendor/mp4-muxer.mjs");
      },
    },
  ],
  clearScreen: false,
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // Route Tauri API imports to Electron compatibility shims
      "@tauri-apps/api/core": bridge("invoke.ts"),
      "@tauri-apps/api/event": bridge("event.ts"),
      "@tauri-apps/api/dialog": bridge("dialog.ts"),
      "@tauri-apps/api/window": bridge("window.ts"),
      "@tauri-apps/api/webviewWindow": bridge("webviewWindow.ts"),
      "@tauri-apps/api/webview": bridge("webviewWindow.ts"),
      "@tauri-apps/plugin-dialog": bridge("dialog.ts"),
      "@tauri-apps/plugin-shell": bridge("shell.ts"),
      "@tauri-apps/plugin-global-shortcut": bridge("globalShortcut.ts"),
    },
  },
});