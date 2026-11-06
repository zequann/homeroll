import { redirect } from "next/navigation";
import { homeFor, mayOpen } from "@/lib/access";
import { readSession } from "@/lib/session";

/** A connected wallet that opens another role's page goes to its own page instead. */
export async function guardPage(pathname: string): Promise<void> {
  const account = await readSession();
  if (account && !mayOpen(pathname, account.role)) redirect(homeFor(account.role));
}
