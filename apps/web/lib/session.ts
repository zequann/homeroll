import { cookies } from "next/headers";
import { z } from "zod";
import { getFixtures } from "@/lib/near";
import type { Signer } from "@/lib/near/client";
import type { DemoAccount, DemoAccountKey } from "@/lib/wallet/adapter";
import { demoWallet } from "@/lib/wallet/demo";

export const SESSION_COOKIE = "hr_demo_account";

const accountKey = z.enum(["owner", "worker:w-7k2q9x", "lender"]);

export function demoAccounts(): DemoAccount[] {
  return demoWallet(getFixtures()).accounts();
}

/** The connected demo account, or null. Anything the cookie holds that does not parse counts as disconnected. */
export async function readSession(): Promise<DemoAccount | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  const parsed = accountKey.safeParse(raw);
  if (!parsed.success) return null;
  return demoAccounts().find((a) => a.key === parsed.data) ?? null;
}

export async function writeSession(key: DemoAccountKey | null): Promise<void> {
  const store = await cookies();
  if (key === null) {
    store.delete(SESSION_COOKIE);
    return;
  }
  store.set(SESSION_COOKIE, accountKey.parse(key), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

export type SignerResult = { connected: true; signer: Signer } | { connected: false };

/** For server actions: the signer for the connected account, only if it has the wanted role. */
export async function requireSigner(role: "owner" | "worker" | "lender"): Promise<SignerResult> {
  const account = await readSession();
  if (!account || account.role.toLowerCase() !== role) return { connected: false };
  return { connected: true, signer: { role, accountId: account.accountId } };
}

/** The payroll agent signs as the employer with its function-call key (SPEC §8.2, §6). */
export function payrollAgentSigner(): Signer {
  return { role: "payrollAgent", accountId: getFixtures().company.accountId };
}
