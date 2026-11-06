import { createHash } from "node:crypto";
import { serialize } from "borsh";
import { describe, expect, it } from "vitest";
import { deriveKey } from "@/lib/keys";
import {
  intentHashOf,
  type Nep413Payload,
  nep413Hash,
  newNonce,
  signNep413,
  verifyNep413,
} from "./nep413";

const owner = deriveKey("ab".repeat(32), "perabotjaya.homeroll-test.testnet", "owner");
const other = deriveKey("ab".repeat(32), "perabotjaya.homeroll-test.testnet", "payrollAgent");
const payload: Nep413Payload = {
  message: JSON.stringify({
    signer_id: owner.accountId,
    deadline: "2026-11-06T10:00:00.000Z",
    intents: [],
  }),
  nonce: newNonce(() => new Uint8Array(32).fill(7)),
  recipient: "homeroll-mock-intents",
};

describe("NEP-413", () => {
  it("hashes the u32 tag 2^31+413, then message, nonce, recipient and no callback, in borsh", () => {
    const tag = Buffer.from([0x9d, 0x01, 0x00, 0x80]);
    const message = Buffer.from(payload.message, "utf8");
    const recipient = Buffer.from(payload.recipient, "utf8");
    const len = (n: number) => Buffer.from(serialize("u32", n));
    const expected = createHash("sha256")
      .update(Buffer.concat([tag, len(message.length), message, Buffer.alloc(32, 7)]))
      .update(Buffer.concat([len(recipient.length), recipient, Buffer.from([0])]))
      .digest();
    expect(Buffer.from(nep413Hash(payload))).toEqual(expected);
  });

  it("verifies what near-api-js signs, and names the signing key", async () => {
    const signed = await signNep413(owner.accountId, owner.secretKey, payload);
    expect(signed.public_key).toBe(owner.publicKey);
    expect(signed.signature).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(verifyNep413(signed)).toBe(true);
  });

  it("refuses a payload changed after signing, a swapped key, or a garbled signature", async () => {
    const signed = await signNep413(owner.accountId, owner.secretKey, payload);
    const changed = {
      ...signed,
      payload: { ...payload, message: payload.message.replace("[]", "[1]") },
    };
    expect(verifyNep413(changed)).toBe(false);
    expect(verifyNep413({ ...signed, public_key: other.publicKey })).toBe(false);
    expect(verifyNep413({ ...signed, signature: "ed25519:1111" })).toBe(false);
  });

  it("refuses a nonce that is not 32 bytes of base64", () => {
    expect(() => nep413Hash({ ...payload, nonce: Buffer.alloc(31).toString("base64") })).toThrow(
      "32 bytes",
    );
  });

  it("derives the intent hash from the signed bytes, so it changes with any field", () => {
    expect(intentHashOf(payload)).not.toBe(intentHashOf({ ...payload, recipient: "intents.near" }));
  });
});
