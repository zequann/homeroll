import { type Fixtures, loadFixtures } from "@homeroll/fixtures";
import { homerollAccounts } from "@homeroll/shared";
import { getActivityLog } from "@/lib/activity";
import { getEnv } from "@/lib/env";
import type { ChainClient } from "./client";
import { FakeChainClient } from "./fake";
import { withActivityLog } from "./logged";
import { NearChainClient } from "./near";

// One fake chain per server process, kept on globalThis so dev hot reload does not reset it.
const globalForChain = globalThis as unknown as { __homerollFake?: FakeChainClient };

export function getChainClient(): ChainClient {
  const env = getEnv();
  if (env.chainClient === "near") {
    return withActivityLog(new NearChainClient(), homerollAccounts(env.root), getActivityLog());
  }
  globalForChain.__homerollFake ??= new FakeChainClient({ fixtures: getFixtures() });
  return globalForChain.__homerollFake;
}

let fixtures: Fixtures | undefined;

export function getFixtures(): Fixtures {
  fixtures ??= loadFixtures(getEnv().root);
  return fixtures;
}
