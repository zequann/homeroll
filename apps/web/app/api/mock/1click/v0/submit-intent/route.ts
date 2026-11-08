import { z } from "zod";
import { syncLiveCompany } from "@/lib/near";
import { badRequest, jsonBody, railResponse } from "@/lib/payout/http";
import type { SignedData } from "@/lib/payout/nep413";
import { payoutRail } from "@/lib/payout/server";

const body = z.object({ type: z.literal("swap_transfer"), signedData: z.unknown() });

/**
 * Mock 1Click `POST /v0/submit-intent` (SPEC §8.11): the R17 checks. Accepting an intent pays
 * nothing by itself; the owner console then runs `pay_run` for it.
 */
export async function POST(request: Request): Promise<Response> {
  await syncLiveCompany();
  const parsed = body.safeParse(await jsonBody(request));
  if (!parsed.success) return badRequest("Expected type swap_transfer and signedData.");
  return railResponse(
    await (await payoutRail()).submitIntent({
      type: "swap_transfer",
      signedData: parsed.data.signedData as SignedData,
    }),
  );
}
