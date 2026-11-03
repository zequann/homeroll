"use server";

import { homerollAccounts } from "@homeroll/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { sen, senToUnits } from "@/lib/fx";
import { getChainClient } from "@/lib/near";
import { MockRoute, SampleQuote } from "@/lib/remit";
import { requireSigner } from "@/lib/session";

export type SendResult = { ok: false; reason: "not-connected" | "too-much" };

/** Send home: the sample quote prices it, the mock partner takes the tokens (SPEC §8.4). */
export async function sendHome(amountSen: unknown): Promise<SendResult> {
  const amount = sen(z.number().int().positive().max(100_000_000).parse(amountSen));
  const session = await requireSigner("worker");
  if (!session.connected) return { ok: false, reason: "not-connected" };

  const chain = getChainClient();
  const balance = await chain.ftBalanceOf(session.signer.accountId);
  if (senToUnits(amount) > balance) return { ok: false, reason: "too-much" };

  const { payout } = homerollAccounts(getEnv().root);
  await MockRoute.execute(chain, session.signer, payout, SampleQuote.quote(amount));
  revalidatePath("/worker");
  revalidatePath("/owner");
  redirect(`/worker/send/done?rm=${amount}`);
}
