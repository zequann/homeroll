import { createHash, randomBytes } from "node:crypto";
import { serialize } from "borsh";
import { base58, signNep413Message, verifyEd25519 } from "@/lib/near/rpc";

/**
 * NEP-413 signed messages, as NEAR wallets sign them and NEAR Intents checks them (SPEC §8.11).
 * Signing goes through near-api-js (in rpc.ts), so the bytes match a wallet's `signMessage`;
 * checking uses our own hash, so a test proves the two agree.
 */

export interface Nep413Payload {
  /** The intent message, a JSON string. */
  message: string;
  /** 32 bytes, base64. */
  nonce: string;
  recipient: string;
  callbackUrl?: string | null;
}

/** `signedData` for standard "nep413", field for field as 1Click's submit-intent takes it. */
export interface SignedData {
  standard: "nep413";
  payload: Nep413Payload;
  /** `ed25519:<base58>` */
  public_key: string;
  /** `ed25519:<base58>` */
  signature: string;
}

// 2^31 + 413: the tag that keeps a signed message from ever being a valid transaction.
const PREFIX = 2_147_484_061;
const PAYLOAD_SCHEMA = {
  struct: {
    message: "string",
    nonce: { array: { type: "u8", len: 32 } },
    recipient: "string",
    callbackUrl: { option: "string" },
  },
} as const;

function nonceBytes(nonce: string): Uint8Array {
  const bytes = Buffer.from(nonce, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== nonce) {
    throw new Error("nonce must be 32 bytes in base64");
  }
  return new Uint8Array(bytes);
}

/** sha256(borsh(u32 prefix) ‖ borsh(payload)): the 32 bytes the key signs. */
export function nep413Hash(payload: Nep413Payload): Uint8Array {
  const prefix = serialize("u32", PREFIX);
  const body = serialize(PAYLOAD_SCHEMA, {
    message: payload.message,
    nonce: nonceBytes(payload.nonce),
    recipient: payload.recipient,
    callbackUrl: payload.callbackUrl ?? null,
  });
  return new Uint8Array(createHash("sha256").update(prefix).update(body).digest());
}

export function newNonce(random: (n: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(32)).toString("base64");
}

/** Signs as `accountId` with an `ed25519:` secret key, the way a wallet's signMessage does. */
export async function signNep413(
  accountId: string,
  secretKey: string,
  payload: Nep413Payload,
): Promise<SignedData> {
  const signed = await signNep413Message(accountId, secretKey, {
    message: payload.message,
    recipient: payload.recipient,
    nonce: nonceBytes(payload.nonce),
    ...(payload.callbackUrl ? { callbackUrl: payload.callbackUrl } : {}),
  });
  return { standard: "nep413", payload, public_key: signed.publicKey, signature: signed.signature };
}

/** True when `signature` is `public_key`'s ed25519 signature over the payload's NEP-413 hash. */
export function verifyNep413(signed: SignedData): boolean {
  try {
    return verifyEd25519(signed.public_key, nep413Hash(signed.payload), signed.signature);
  } catch {
    return false;
  }
}

/** The intent hash 1Click returns: the NEP-413 hash in base58. */
export function intentHashOf(payload: Nep413Payload): string {
  return base58(nep413Hash(payload));
}
