import { type Fixtures, loadFixtures } from "@homeroll/fixtures";
import { getEnv } from "@/lib/env";
import type { ChainClient } from "./client";
import { overlayLiveCompany } from "./demo-company";

export { syncLiveCompany } from "./demo-company";

import { FakeChainClient } from "./fake";
import { NearChainClient } from "./near";
import { recordingActivity } from "./recorded";

// One fake chain per server process, kept on globalThis so dev hot reload does not reset it.
const globalForChain = globalThis as unknown as { __homerollFake?: FakeChainClient };

export function getChainClient(): ChainClient {
  const env = getEnv();
  // The fake chain records its own activity; testnet calls are recorded by this wrapper
  if (env.chainClient === "near") return recordingActivity(new NearChainClient(), env.root);
  globalForChain.__homerollFake ??= new FakeChainClient({ fixtures: getFixtures() });
  return globalForChain.__homerollFake;
}

let fixtureBase: Fixtures | undefined;

export function getFixtures(): Fixtures {
  fixtureBase ??= loadFixtures(getEnv().root);
  return overlayLiveCompany(fixtureBase);
}
