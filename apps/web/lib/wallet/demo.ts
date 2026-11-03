import type { Fixtures } from "@homeroll/fixtures";
import type { DemoAccount, WalletAdapter } from "./adapter";

export function demoWallet(fixtures: Fixtures): WalletAdapter {
  const rahim = fixtures.workers[0];
  if (!rahim) throw new Error("fixtures have no workers");
  const accounts: DemoAccount[] = [
    {
      key: "owner",
      name: fixtures.company.name,
      shortName: fixtures.company.name.replace(/ Sdn Bhd$/, ""),
      role: "Owner",
      accountId: fixtures.company.accountId,
    },
    {
      key: "worker:w-7k2q9x",
      name: rahim.displayName,
      shortName: rahim.displayName.split(" ")[0] ?? rahim.displayName,
      role: "Worker",
      accountId: rahim.accountId,
    },
    {
      key: "lender",
      name: fixtures.lender.name,
      shortName: fixtures.lender.name,
      role: "Lender",
      accountId: fixtures.lender.accountId,
    },
  ];
  return { kind: "demo", accounts: () => accounts };
}
