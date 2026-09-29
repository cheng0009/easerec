/**
 * Pro license code format — the single source of truth shared by the keygen
 * script (signing side) and the app (verification side).
 *
 * Layout (v1, perpetual, NOT machine-bound):
 *   payload  = version(1B) + tier(1B) + issuedDay(4B LE, days since
 *              2026-01-01) + nonce(8B random)            = 14 bytes
 *   sig      = Ed25519 signature over the payload (FULL 64 bytes — a
 *              truncated Ed25519 sig cannot be verified at all; short
 *              offline codes require symmetric MACs, which ship the secret
 *              in the binary and are forgeable once extracted)
 *   code     = base62(payload) padded to 20 chars + "-" + base62(sig)
 *              padded to 89 chars, grouped cosmetically with dashes.
 *
 * The code is ~110 chars — a paste-size string, matching the card-style
 * auto-delivery channel (爱发电 etc). Verification normalizes away all
 * dashes / whitespace / newlines before decoding.
 */

import { randomBytes, sign as cryptoSign } from "node:crypto";

export const LICENSE_CODE_VERSION = 1;
export const TIER_PRO = 1;
export const EPOCH_DAY_MS = Date.UTC(2026, 0, 1);

const B62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PAYLOAD_B62_LEN = 20; // 14 bytes always fits in 20 base62 chars
const SIG_B62_LEN = 89;     // 64 bytes always fits in 89 base62 chars

function bytesToB62(bytes, padLen) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B62_ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(padLen, "0");
}

function b62ToBytes(s, expectLen) {
  let n = 0n;
  for (const ch of s) {
    const v = B62_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 62n + BigInt(v);
  }
  const out = new Uint8Array(expectLen);
  for (let i = expectLen - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
    if (n === 0n && i > 0) break; // remaining stay zero (left-pad)
  }
  if (n !== 0n) return null; // longer than expected
  return out;
}

export function dayNumberSinceEpoch(date = new Date()) {
  return Math.max(0, Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - EPOCH_DAY_MS) / 86400000));
}

export function packLicensePayload({ tier, issuedDay, nonce }) {
  const p = new Uint8Array(14);
  p[0] = LICENSE_CODE_VERSION;
  p[1] = tier & 0xff;
  new DataView(p.buffer).setUint32(2, issuedDay >>> 0, true);
  p.set(nonce, 6);
  return p;
}

export function unpackLicensePayload(bytes) {
  if (!bytes || bytes.length !== 14) return null;
  if (bytes[0] !== LICENSE_CODE_VERSION) return null;
  return {
    version: bytes[0],
    tier: bytes[1],
    issuedDay: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true),
    nonce: bytes.slice(6, 14),
  };
}

/** Canonical single-line code (one dash separating the two parts). */
export function encodeLicenseCode(payload, sig) {
  return `${bytesToB62(payload, PAYLOAD_B62_LEN)}-${bytesToB62(sig, SIG_B62_LEN)}`;
}

/** Pretty-print for delivery cards: groups of 6 for human counting. */
export function formatLicenseForDisplay(code) {
  const flat = code.replace(/[^0-9A-Za-z]/g, "");
  return (flat.match(/.{1,6}/g) ?? []).join("-");
}

/** Accept anything copy-pasted: dashes, spaces, newlines. Case is
 *  SIGNIFICANT (base62) and must be preserved by the copy path. */
export function decodeLicenseCode(raw) {
  const flat = String(raw || "").replace(/[^0-9A-Za-z]/g, "");
  if (flat.length !== PAYLOAD_B62_LEN + SIG_B62_LEN) return null;
  const payload = b62ToBytes(flat.slice(0, PAYLOAD_B62_LEN), 14);
  const sig = b62ToBytes(flat.slice(PAYLOAD_B62_LEN), 64);
  if (!payload || !sig) return null;
  return { payload, sig };
}

// ---- signing side (keygen script + tests only) ----

export function signLicensePayload(payload, privateKeyPem) {
  return new Uint8Array(cryptoSign(null, Buffer.from(payload), Buffer.from(privateKeyPem, "utf8")));
}

export function makeProLicense(privateKeyPem, { nonce = randomBytes(8), issuedDay = dayNumberSinceEpoch() } = {}) {
  const payload = packLicensePayload({ tier: TIER_PRO, issuedDay, nonce });
  const sig = signLicensePayload(payload, privateKeyPem);
  const code = encodeLicenseCode(payload, sig);
  return {
    code,
    display: formatLicenseForDisplay(code),
    licenseNo: BigInt(`0x${Buffer.from(nonce).toString("hex")}`).toString(36).toUpperCase().padStart(13, "0"),
    issuedDay,
  };
}
