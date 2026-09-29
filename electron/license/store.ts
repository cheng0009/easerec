/**
 * Pro license persistence (main process). The activated code lives in
 * userData/pro-license.json and is re-verified on every read — the renderer
 * is never trusted to report its own license state.
 */

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { verifyLicenseCode, type LicenseInfo } from "./license";

export interface LicenseStatus {
  licensed: boolean;
  info?: LicenseInfo;
}

function licenseFile(): string {
  return path.join(app.getPath("userData"), "pro-license.json");
}

export function getLicenseStatus(): LicenseStatus {
  try {
    const raw = JSON.parse(fs.readFileSync(licenseFile(), "utf8")) as { code?: string };
    if (raw && typeof raw.code === "string" && raw.code) {
      const info = verifyLicenseCode(raw.code);
      if (info) return { licensed: true, info };
    }
  } catch { /* absent/corrupt = not licensed */ }
  return { licensed: false };
}

export function applyLicenseCode(code: string): { ok: boolean; licensed?: boolean; info?: LicenseInfo; error?: string } {
  const clean = String(code || "").trim();
  const info = verifyLicenseCode(clean);
  if (!info) {
    return { ok: false, error: "注册码无效 — 请从购买卡片完整复制后重试（注意保留大小写）" };
  }
  fs.mkdirSync(path.dirname(licenseFile()), { recursive: true });
  fs.writeFileSync(licenseFile(), JSON.stringify({ code: clean.replace(/[^0-9A-Za-z]/g, "") }, null, 2), "utf8");
  return { ok: true, licensed: true, info };
}
