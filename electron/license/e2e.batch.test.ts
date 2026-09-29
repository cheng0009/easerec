/** One-shot: verify a REAL code from the generated batch against the
 *  compiled-in public key. Guards the production keygen->app pipeline. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { verifyLicenseCode } from "./license";

describe("generated batch (real keys)", () => {
  it("the keygen's codes verify against the app's public key", () => {
    const dir = ".license-codes";
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".txt")) : [];
    if (files.length === 0) return; // codes never committed — skip in CI
    const codes = fs.readFileSync(`${dir}/${files[files.length - 1]}`, "utf8").split(/\r?\n/).filter(Boolean);
    expect(codes.length).toBeGreaterThan(100);
    const info = verifyLicenseCode(codes[0]);
    expect(info).not.toBeNull();
    expect(info!.tier).toBe("pro");
    // a broken copy (dropped char) must fail
    expect(verifyLicenseCode(codes[0].slice(0, -4))).toBeNull();
  });
});
