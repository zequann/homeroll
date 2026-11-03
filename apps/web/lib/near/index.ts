import { type Fixtures, loadFixtures } from "@homeroll/fixtures";
import { getEnv } from "@/lib/env";
import type { ChainClient } from "./client";
import { FakeChainClient } from "./fake";
import { NearChainClient } from "./near";

// One fake chain per server process, kept on globalThis so dev hot reload does not reset it.
const globalForChain = globalThis as unknown as { __homerollFake?: FakeChainClient };

export function getChainClient(): ChainClient {
  const env = getEnv();
  if (env.chainClient === "near") return new NearChainClient();
  globalForChain.__homerollFake ??= new FakeChainClient({ fixtures: getFixtures() });
  return globalForChain.__homerollFake;
}

let fixtures: Fixtures | undefined;

export function getFixtures(): Fixtures {
  fixtures ??= loadFixtures(getEnv().root);
  return fixtures;
}
