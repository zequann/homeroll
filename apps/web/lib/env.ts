import { z } from "zod";

/**
 * Server env, read once. `NEAR_ROOT_ACCOUNT` is the only source of the root (CLAUDE.md
 * conventions); the fake chain alone gets a labelled stand-in so `CHAIN_CLIENT=fake pnpm dev`
 * runs with no .env.local.
 */
export const FAKE_MODE_ROOT = "homeroll-demo.testnet";

const schema = z.object({
  CHAIN_CLIENT: z.enum(["fake", "near"]).default("fake"),
  NEAR_ROOT_ACCOUNT: z.string().min(2).optional(),
  INTENTS_QUOTES: z.enum(["live", "sample"]).optional(),
});

export interface Env {
  chainClient: "fake" | "near";
  root: string;
  /** Live dry-run swap quotes, or labelled samples. The fake chain samples unless told (SPEC §8.4). */
  intentsQuotes: "live" | "sample";
}

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.parse({
    CHAIN_CLIENT: process.env.CHAIN_CLIENT || undefined,
    NEAR_ROOT_ACCOUNT: process.env.NEAR_ROOT_ACCOUNT || undefined,
    INTENTS_QUOTES: process.env.INTENTS_QUOTES || undefined,
  });
  if (parsed.CHAIN_CLIENT === "near" && !parsed.NEAR_ROOT_ACCOUNT) {
    throw new Error("CHAIN_CLIENT=near needs NEAR_ROOT_ACCOUNT (see .env.example)");
  }
  cached = {
    chainClient: parsed.CHAIN_CLIENT,
    root: parsed.NEAR_ROOT_ACCOUNT ?? FAKE_MODE_ROOT,
    intentsQuotes: parsed.INTENTS_QUOTES ?? (parsed.CHAIN_CLIENT === "near" ? "live" : "sample"),
  };
  return cached;
}
