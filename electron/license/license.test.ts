import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { verifyLicenseCodeWith, verifyLicenseCode } from "./license";
import { LICENSE_PUBLIC_KEY_HEX } from "./publickey";
import {
  dayNumberSinceEpoch,
  decodeLicenseCode,
  encodeLicenseCode,
  formatLicenseForDisplay,
  makeProLicense,
  packLicensePayload,
  unpackLicensePayload,
} from "./license-format.mjs";

// A THROWAWAY keypair for sign+verify round-trips — never the real secret.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIV = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUB_HEX = Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("hex");

describe("pro license codes", () => {
  it("round-trips: sign -> code -> verify, with license number and issue date", () => {
    const lic = makeProLicense(PRIV);
    const info = verifyLicenseCodeWith(PUB_HEX, lic.display);
    expect(info).not.toBeNull();
    expect(info!.tier).toBe("pro");
    expect(info!.licenseNo).toBe(lic.licenseNo);
    expect(info!.issuedAtIso).toBe(new Date().toISOString().slice(0, 10));
  });

  it("accepts mangled pastes: spaces, newlines, arbitrary dashes (case is significant)", () => {
    const lic = makeProLicense(PRIV);
    const mangled = lic.display
      .replace(/-/g, "\n")
      .split("\n")
      .map((s, i) => (i % 2 ? `  ${s} ` : s))
      .join("\n");
    expect(verifyLicenseCodeWith(PUB_HEX, mangled)).not.toBeNull();
  });

  it("rejects a code signed by a different key", () => {
    const lic = makeProLicense(PRIV);
    const other = generateKeyPairSync("ed25519");
    const otherHex = Buffer.from(other.publicKey.export({ type: "spki", format: "der" })).toString("hex");
    expect(verifyLicenseCodeWith(otherHex, lic.display)).toBeNull();
  });

  it("rejects tampered payloads and signatures", () => {
    const lic = makeProLicense(PRIV);
    const dec = decodeLicenseCode(lic.code)!;
    // Flip one payload byte (nonce) and re-encode.
    const badPayload = new Uint8Array(dec.payload);
    badPayload[13] ^= 0x01;
    const tampered = encodeLicenseCode(badPayload, dec.sig);
    expect(verifyLicenseCodeWith(PUB_HEX, tampered)).toBeNull();
    // Flip one signature character.
    const flat = lic.code.replace(/[^0-9A-Za-z]/g, "");
    const idx = flat.length - 3;
    const flipped = flat.slice(0, idx) + (flat[idx] === "A" ? "B" : "A") + flat.slice(idx + 1);
    expect(verifyLicenseCodeWith(PUB_HEX, flipped)).toBeNull();
  });

  it("rejects garbage, wrong length and unknown versions", () => {
    expect(verifyLicenseCodeWith(PUB_HEX, "")).toBeNull();
    expect(verifyLicenseCodeWith(PUB_HEX, "ABC123")).toBeNull();
    expect(decodeLicenseCode("0".repeat(109))).not.toBeNull(); // right length...
    const v0 = packLicensePayload({ tier: 1, issuedDay: dayNumberSinceEpoch(), nonce: new Uint8Array(8) });
    v0[0] = 99; // unknown version
    expect(unpackLicensePayload(v0)).toBeNull(); // ...but unpack refuses it
  });

  it("codes are unique and the display grouping round-trips", () => {
    const a = makeProLicense(PRIV);
    const b = makeProLicense(PRIV);
    expect(a.code).not.toBe(b.code);
    expect(a.licenseNo).not.toBe(b.licenseNo);
    expect(formatLicenseForDisplay(a.code).replace(/[^0-9A-Za-z]/g, "")).toBe(a.code.replace(/[^0-9A-Za-z]/g, ""));
  });

  it("the compiled-in public key is a valid Ed25519 SPKI", () => {
    expect(LICENSE_PUBLIC_KEY_HEX).toMatch(/^[0-9a-f]{40,}$/);
    // A code signed with the throwaway key must NOT verify against the real one.
    expect(verifyLicenseCode(makeProLicense(PRIV).display)).toBeNull();
  });
});
