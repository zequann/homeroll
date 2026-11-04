import { workerAccountId } from "@homeroll/shared";
import { describe, expect, it } from "vitest";
import { deriveKey } from "../keys";
import { decodeSignedDelegate, signDelegate } from "./rpc";

const SEED = "ab".repeat(32);
const ROOT = "homeroll.testnet";

describe("signed delegate round trip", () => {
  it("decodes the bytes signDelegate produced and accepts the signature", async () => {
    const worker = deriveKey(SEED, workerAccountId("w-7k2q9x", ROOT), "worker");
    const args = new TextEncoder().encode(
      JSON.stringify({ receiver_id: `payout.${ROOT}`, amount: "1000000" }),
    );
    const raw = await signDelegate(worker, {
      senderId: worker.accountId,
      receiverId: `tusdc.${ROOT}`,
      method: "ft_transfer",
      args,
      gas: 15n * 1_000_000_000_000n,
      depositYocto: 1n,
      nonce: 1n,
      maxBlockHeight: 100n,
      publicKey: worker.publicKey,
    });

    const decoded = decodeSignedDelegate(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.delegate.signatureOk).toBe(true);
    expect(decoded.delegate.senderId).toBe(worker.accountId);
    expect(decoded.delegate.receiverId).toBe(`tusdc.${ROOT}`);
    expect(decoded.delegate.actions).toEqual([
      expect.objectContaining({
        kind: "functionCall",
        method: "ft_transfer",
        depositYocto: 1n,
        gas: 15n * 1_000_000_000_000n,
      }),
    ]);
    const call = decoded.delegate.actions[0];
    if (!call || call.kind !== "functionCall") return;
    expect(call.args).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(call.args))).toEqual({
      receiver_id: `payout.${ROOT}`,
      amount: "1000000",
    });
  });
});
