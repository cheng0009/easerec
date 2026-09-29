/** Type declarations for license-format.mjs (shared by app, tests, keygen). */
export declare const LICENSE_CODE_VERSION = 1;
export declare const TIER_PRO = 1;
export declare const EPOCH_DAY_MS: number;
export declare function dayNumberSinceEpoch(date?: Date): number;
export declare function packLicensePayload(opts: { tier: number; issuedDay: number; nonce: Uint8Array }): Uint8Array;
export declare function unpackLicensePayload(bytes: Uint8Array): { version: number; tier: number; issuedDay: number; nonce: Uint8Array } | null;
export declare function encodeLicenseCode(payload: Uint8Array, sig: Uint8Array): string;
export declare function formatLicenseForDisplay(code: string): string;
export declare function decodeLicenseCode(raw: string): { payload: Uint8Array; sig: Uint8Array } | null;
export declare function signLicensePayload(payload: Uint8Array, privateKeyPem: string): Uint8Array;
export declare function makeProLicense(privateKeyPem: string, opts?: { nonce?: Uint8Array; issuedDay?: number }): { code: string; display: string; licenseNo: string; issuedDay: number };
