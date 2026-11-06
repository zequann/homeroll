import { hkdfSync } from "node:crypto";
import type { AccountId } from "@homeroll/shared";
import { getEnv } from "@/lib/env";
import { type DerivedKey, deriveKey, type KeyRole } from "@/lib/keys";

/**
 * Seed for the fake chain's demo keys. Public on purpose: these keys exist on no network, and
 * the fake chain only uses their public halves, so signature checks run the same as on testnet.
 */
export const FAKE_CHAIN_SEED = "fa4e".repeat(16);

function serverSeed(): string {
  if (getEnv().chainClient === "fake") return FAKE_CHAIN_SEED;
  const seed = process.env.SERVER_KEY_SEED?.trim();
  if (!seed) throw new Error("SERVER_KEY_SEED is not set");
  return seed;
}

/** The key the server holds for a demo account (SPEC §12). Testnet: derived from SERVER_KEY_SEED. */
export function demoKey<R extends KeyRole>(accountId: AccountId, role: R): DerivedKey<R> {
  return deriveKey(serverSeed(), accountId, role);
}

/** A 32-byte secret for one server purpose, from the same seed, so no new secret is stored. */
export function serverSecret(purpose: string): Uint8Array {
  const info = `homeroll/v1/secret/${purpose}`;
  return new Uint8Array(
    hkdfSync("sha256", Buffer.from(serverSeed(), "hex"), Buffer.alloc(32), info, 32),
  );
}
