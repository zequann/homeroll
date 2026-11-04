import { describe, expect, it } from "vitest";
import { adminSigner, deriveKey } from "./keys";

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
