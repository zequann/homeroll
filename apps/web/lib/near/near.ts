import type { ChainClient } from "./client";

const NOT_BUILT = "NearChainClient is not built yet (on-chain dev, SPEC §8.8)";

/**
 * Testnet client. The on-chain dev's file: every method throws until it is written against
 * `client.suite.ts`, the same behaviour suite `FakeChainClient` passes.
 */
export class NearChainClient implements ChainClient {
  readonly network = "testnet" as const;

  getEmployer(): never {
    throw new Error(NOT_BUILT);
  }
  getPayees(): never {
    throw new Error(NOT_BUILT);
  }
  getRuns(): never {
    throw new Error(NOT_BUILT);
  }
  getInvoice(): never {
    throw new Error(NOT_BUILT);
  }
  getPool(): never {
    throw new Error(NOT_BUILT);
  }
  ftBalanceOf(): never {
    throw new Error(NOT_BUILT);
  }
  getAccessKeys(): never {
    throw new Error(NOT_BUILT);
  }
  submitRun(): never {
    throw new Error(NOT_BUILT);
  }
  payRun(): never {
    throw new Error(NOT_BUILT);
  }
  attestInvoice(): never {
    throw new Error(NOT_BUILT);
  }
  settleInvoice(): never {
    throw new Error(NOT_BUILT);
  }
  requestAdvance(): never {
    throw new Error(NOT_BUILT);
  }
  ftTransfer(): never {
    throw new Error(NOT_BUILT);
  }
  resetDemo(): never {
    throw new Error(NOT_BUILT);
  }
}
