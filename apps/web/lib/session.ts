import { getFixtures } from "@/lib/near";
import type { Signer } from "@/lib/near/client";
import type { DemoAccount } from "@/lib/wallet/adapter";
import { demoWallet } from "@/lib/wallet/demo";

/**
 * One shared demo (SPEC D7). Every visitor, judge or tester acts on the same three demo accounts,
 * and each page signs as its own role: /owner as the employer, /worker as Rahim, /lender as the
 * lender. The server holds the keys; no key and no account choice reaches the browser. Reset demo
 * gives the next visitor a fresh company.
 */

export type DemoRole = "owner" | "worker" | "lender";

export function demoAccounts(): DemoAccount[] {
  return demoWallet(getFixtures()).accounts();
}

export function demoAccount(role: DemoRole): DemoAccount {
  const account = demoAccounts().find((a) => a.role.toLowerCase() === role);
  if (!account) throw new Error(`No demo account for ${role}`);
  return account;
}

/** The server-held demo key that signs for this role. */
export function demoSigner(role: DemoRole): Signer {
  return { role, accountId: demoAccount(role).accountId };
}

/** The payroll agent signs as the employer with its function-call key (SPEC §8.2, §6). */
export function payrollAgentSigner(): Signer {
  return { role: "payrollAgent", accountId: getFixtures().company.accountId };
}
