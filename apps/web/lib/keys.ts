import { createPrivateKey, createPublicKey, hkdfSync } from "node:crypto";
import { type InspectOptions, inspect } from "node:util";
import type { AccountId } from "@homeroll/shared";

/** Closed on purpose. A new role is a new union member, not a new function. */
export type KeyRole =
  | "relayer"
  | "worker"
  | "owner"
  | "payrollAgent"
  | "invoiceAgent"
  | "escrow"
  | "solver"
  | "lender"
  | "payout"
  | "offramp";

export type DerivedKey<R extends KeyRole = KeyRole> = {
  role: R;
  accountId: AccountId;
  /** ed25519 public key, near-api-js string form `ed25519:...`. Safe to log. */
  publicKey: string;
  /**
   * ed25519 secret, `ed25519:<base58 of the 32-byte seed>`.
   * Redacted in inspect and toJSON.
   */
  secretKey: string;
};

export type RelayerSigner = DerivedKey<"relayer">;
export type WorkerSigner = DerivedKey<"worker">;

/** The root key from HOMEROLL_ADMIN_PRIVATE_KEY. Not a DerivedKey. */
export type AdminSigner = {
  role: "admin";
  accountId: AccountId;
  secretKey: string;
};

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ZERO_SALT = Buffer.alloc(32);
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = `1${out}`;
    else break;
  }
  return out || "1";
}

function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of text) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

function nearKeyString(raw32: Uint8Array): string {
  return `ed25519:${base58Encode(raw32)}`;
}

function ed25519PublicFromSeed(seed: Uint8Array): string {
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed)]);
  const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const pubDer = createPublicKey(priv).export({ type: "spki", format: "der" });
  const pubRaw = pubDer.subarray(pubDer.length - 32);
  return nearKeyString(pubRaw);
}

function redactDerived<R extends KeyRole>(key: DerivedKey<R>): DerivedKey<R> {
  const redacted = "[redacted]";
  return Object.assign(key, {
    [inspect.custom](_depth: number, opts: InspectOptions) {
      return inspect({ ...key, secretKey: redacted }, opts);
    },
    toJSON() {
      return {
        role: key.role,
        accountId: key.accountId,
        publicKey: key.publicKey,
        secretKey: redacted,
      };
    },
  });
}

/**
 * Public key for an existing `ed25519:` secret string. Node crypto only.
 * A NEAR wallet export is 64 bytes (seed, then public key). near-api-js signs
 * with the first 32. A bare 32-byte seed is the same key.
 */
export function publicKeyFromSecretKey(secretKey: string): string {
  if (!secretKey.startsWith("ed25519:")) {
    throw new Error("expected ed25519 secret key");
  }
  const decoded = base58Decode(secretKey.slice("ed25519:".length));
  const seed = decoded.length === 64 ? decoded.subarray(0, 32) : decoded;
  if (seed.length !== 32) throw new Error("invalid ed25519 seed length");
  const publicKey = ed25519PublicFromSeed(seed);
  if (decoded.length === 64 && nearKeyString(decoded.subarray(32)) !== publicKey) {
    throw new Error("ed25519 secret does not match its public key");
  }
  return publicKey;
}

export function deriveKey<R extends KeyRole>(
  seedHex: string,
  accountId: AccountId,
  role: R,
): DerivedKey<R> {
  const info = Buffer.from(`homeroll/v1/${role}/${accountId}`, "utf8");
  const seed = Buffer.from(seedHex, "hex");
  const derived = Buffer.from(hkdfSync("sha256", seed, ZERO_SALT, info, 32));
  const key: DerivedKey<R> = {
    role,
    accountId,
    publicKey: ed25519PublicFromSeed(derived),
    secretKey: nearKeyString(derived),
  };
  return redactDerived(key);
}

export function adminSigner(accountId: AccountId, secretKey: string | null): AdminSigner | null {
  if (secretKey === null || secretKey === "") return null;
  if (!secretKey.startsWith("ed25519:")) return null;
  return { role: "admin", accountId, secretKey };
}
