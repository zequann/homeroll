"use server";

import { type AccountId, homerollAccounts } from "@homeroll/shared";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { labelAction } from "@/lib/activity";
import { type CashoutDestination, mockDuitNow } from "@/lib/cashout";
import { getEnv } from "@/lib/env";
import { type Sen, sen, senToUnits, units } from "@/lib/fx";
import { quoteSwapLeg } from "@/lib/intents";
import { getMockLedger } from "@/lib/mock/ledger";
import { getChainClient, getFixtures, syncLiveCompany } from "@/lib/near";
import { MockRoute, quoteWithSwap, type RemitQuote, SampleQuote } from "@/lib/remit";
import { demoSigner } from "@/lib/session";
import { workerTransfer } from "@/lib/worker-transfer";

export type SendResult =
  | { ok: false; reason: "too-much" }
  /** The relayer refused to pay for it (SPEC §8.3); `message` is the rule in plain words. */
  | { ok: false; reason: "relayer"; rule: string; message: string };

const amountSchema = z.number().int().positive().max(100_000_000);

class RelayerRefused extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
  }
}

/** A worker transfer through the relayer, the same path a phone's delegate action takes. */
function transferAs(from: AccountId) {
  return async (to: AccountId, amount: bigint, memo: string) => {
    const r = await workerTransfer(from, to, units(amount), memo);
    if (!r.ok) throw new RelayerRefused(r.rule, r.message);
    return { txHash: r.txHash };
  };
}

function refresh() {
  revalidatePath("/worker");
  revalidatePath("/owner");
}

/** The swap leg for this amount: live when configured and reachable, otherwise a labelled sample. */
async function priceSendHome(amount: Sen): Promise<RemitQuote> {
  if (getEnv().intentsQuotes === "live") {
    const live = await quoteSwapLeg(senToUnits(amount));
    if (live) return quoteWithSwap(amount, live.bps, "live");
  }
  return SampleQuote.quote(amount);
}

/** For the Send home screen, as the amount changes. Asks for a dry-run quote; moves nothing. */
export async function priceSwap(amountSen: unknown): Promise<RemitQuote> {
  await syncLiveCompany();
  return priceSendHome(sen(amountSchema.parse(amountSen)));
}

/** Send home: the quote prices it, the mock partner takes the tokens (SPEC §8.4). */
export async function sendHome(amountSen: unknown): Promise<SendResult> {
  await syncLiveCompany();
  labelAction("Send home");
  const amount = sen(amountSchema.parse(amountSen));
  const signer = demoSigner("worker");

  const balance = await getChainClient().ftBalanceOf(signer.accountId);
  if (senToUnits(amount) > balance) return { ok: false, reason: "too-much" };

  const { payout } = homerollAccounts(getEnv().root);
  const family = getFixtures().workers.find((w) => w.accountId === signer.accountId)?.family;
  let ref: string;
  try {
    ({ ref } = await MockRoute.execute(
      transferAs(signer.accountId),
      payout,
      await priceSendHome(amount),
      getMockLedger(),
      family?.wallet ?? "bKash",
    ));
  } catch (e) {
    if (e instanceof RelayerRefused) {
      return { ok: false, reason: "relayer", rule: e.rule, message: e.message };
    }
    throw e;
  }
  refresh();
  redirect(`/worker/send/done?rm=${amount}&ref=${encodeURIComponent(ref)}`);
}

export type CashoutResult = SendResult;

/** Cash out to DuitNow through the mock off-ramp (SPEC §8.5). */
export async function cashOut(amountSen: unknown, destination: unknown): Promise<CashoutResult> {
  await syncLiveCompany();
  labelAction("Cash out");
  const amount = sen(amountSchema.parse(amountSen));
  const dest = z.enum(["tng", "bank"]).parse(destination) satisfies CashoutDestination;
  const signer = demoSigner("worker");

  const balance = await getChainClient().ftBalanceOf(signer.accountId);
  if (senToUnits(amount) > balance) return { ok: false, reason: "too-much" };

  const { offramp } = homerollAccounts(getEnv().root);
  let ref: string;
  try {
    ({ ref } = await mockDuitNow(getMockLedger()).execute(
      transferAs(signer.accountId),
      offramp,
      amount,
      dest,
    ));
  } catch (e) {
    if (e instanceof RelayerRefused) {
      return { ok: false, reason: "relayer", rule: e.rule, message: e.message };
    }
    throw e;
  }
  refresh();
  redirect(`/worker/cashout/done?ref=${encodeURIComponent(ref)}`);
}
