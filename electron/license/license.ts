/**
 * Pro license verification (app side). A code carries the license payload
 * plus a FULL Ed25519 signature produced by the offline keygen script; the
 * matching public key is compiled into the app. Forging a code without the
 * private key is cryptographically impossible — the practical attack is
 * binary patching, which this deliberately does not fight (挡君子).
 *
 * Licenses are perpetual and NOT machine-bound: one code follows the user
 * across machines and app updates. The nonce doubles as a display license
 * number for support conversations.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { decodeLicenseCode, unpackLicensePayload, TIER_PRO, EPOCH_DAY_MS } from "./license-format.mjs";
import { LICENSE_PUBLIC_KEY_HEX } from "./publickey";

export interface LicenseInfo {
  tier: "pro";
  /** Human-facing license number (base36 of the nonce). */
  licenseNo: string;
  /** ISO date the code was issued. */
  issuedAtIso: string;
}

function licenseNoOf(nonce: Uint8Array): string {
  let n = 0n;
  for (const b of nonce) n = (n << 8n) | BigInt(b);
  return n.toString(36).toUpperCase().padStart(13, "0");
}

function issuedIso(day: number): string {
  return new Date(EPOCH_DAY_MS + day * 86400000).toISOString().slice(0, 10);
}

/** Verify a code against an explicit public key (hex SPKI DER). */
export function verifyLicenseCodeWith(publicKeyHex: string, rawCode: string): LicenseInfo | null {
  const dec = decodeLicenseCode(rawCode);
  if (!dec) return null;
  const payload = unpackLicensePayload(dec.payload);
  if (!payload || payload.tier !== TIER_PRO) return null;
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(publicKeyHex, "hex"), format: "der", type: "spki" });
  } catch {
    return null;
  }
  const ok = cryptoVerify(null, Buffer.from(dec.payload), key, Buffer.from(dec.sig));
  if (!ok) return null;
  return {
    tier: "pro",
    licenseNo: licenseNoOf(payload.nonce),
    issuedAtIso: issuedIso(payload.issuedDay),
  };
}

/** Verify a code against the app's compiled-in public key. */
export function verifyLicenseCode(rawCode: string): LicenseInfo | null {
  return verifyLicenseCodeWith(LICENSE_PUBLIC_KEY_HEX, rawCode);
}
