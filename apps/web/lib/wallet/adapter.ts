import type { AccountId } from "@homeroll/shared";

/** Which demo account the server signs as. The cookie stores only this key, never a secret. */
export type DemoAccountKey = "owner" | "worker:w-7k2q9x" | "lender";

export interface DemoAccount {
  key: DemoAccountKey;
  /** Full name, shown in the sheet. */
  name: string;
  /** Short name, shown on the toolbar button. */
  shortName: string;
  role: "Owner" | "Worker" | "Lender";
  accountId: AccountId;
}

/**
 * Wallet seam (SPEC D7). `demo` is used in fake and near mode: P0 signs with server-held demo
 * keys. `near-connect` is the P1 wallet and is a stub in this build.
 */
export interface WalletAdapter {
  kind: "demo" | "near-connect";
  accounts(): DemoAccount[];
}
