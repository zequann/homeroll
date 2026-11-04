import { describe, expect, it } from "vitest";
import { adminSigner, deriveKey, publicKeyFromSecretKey } from "./keys";

describe("deriveKey", () => {
  it("matches a fixed HKDF vector", () => {
    const seedHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const key = deriveKey(seedHex, "relayer.homeroll.testnet", "relayer");
    expect(key.publicKey).toBe("ed25519:G2wCFo1YhKh4JRqtGAWp5PadHbzMBsQyrngB6Do53iaw");
    expect(key.secretKey).toBe("ed25519:6En9pQ84iEKgcLgUGSkNQymtBQE8spHSca8PxsphQbPP");
    expect(key.role).toBe("relayer");
    expect(key.accountId).toBe("relayer.homeroll.testnet");
  });

  it("redacts the secret in JSON", () => {
    const key = deriveKey("00".repeat(32), "relayer.demo.testnet", "relayer");
    const json = JSON.parse(JSON.stringify(key)) as { secretKey: string; publicKey: string };
    expect(json.secretKey).toBe("[redacted]");
    expect(json.publicKey.startsWith("ed25519:")).toBe(true);
  });
});

describe("adminSigner", () => {
  it("returns null for absent keys", () => {
    expect(adminSigner("homeroll.testnet", null)).toBeNull();
    expect(adminSigner("homeroll.testnet", "")).toBeNull();
  });

  it("accepts an ed25519 secret", () => {
    const admin = adminSigner(
      "homeroll.testnet",
      "ed25519:6En9pQ84iEKgcLgUGSkNQymtBQE8spHSca8PxsphQbPP",
    );
    expect(admin?.role).toBe("admin");
    expect(admin?.accountId).toBe("homeroll.testnet");
  });
});

describe("publicKeyFromSecretKey", () => {
  const seed = "ed25519:6En9pQ84iEKgcLgUGSkNQymtBQE8spHSca8PxsphQbPP";
  const publicKey = "ed25519:G2wCFo1YhKh4JRqtGAWp5PadHbzMBsQyrngB6Do53iaw";
  // Same key as the seed above, in the 64-byte form a NEAR wallet exports.
  const walletExport =
    "ed25519:2ZEyvUGaeuyQcTwYJSzJVnv4MvaWnGKPaxeuvgk7b5mcfY2gQLZCreTr5PeNhq1fy9m2FLh3uBWpdDycNKMQ5U51";

  it("reads a 32-byte seed and a 64-byte wallet export as the same public key", () => {
    expect(publicKeyFromSecretKey(seed)).toBe(publicKey);
    expect(publicKeyFromSecretKey(walletExport)).toBe(publicKey);
  });
});
