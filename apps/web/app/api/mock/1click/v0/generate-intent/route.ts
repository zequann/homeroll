import { z } from "zod";
import { syncLiveCompany } from "@/lib/near";
import { badRequest, jsonBody, railResponse } from "@/lib/payout/http";
import { payoutRail } from "@/lib/payout/server";

const body = z.object({
  type: z.literal("swap_transfer"),
  standard: z.literal("nep413"),
  signerId: z.string(),
  depositAddress: z.string(),
});

/** Mock 1Click `POST /v0/generate-intent` (SPEC §8.11): the NEP-413 payout intent to sign. */
export async function POST(request: Request): Promise<Response> {
  await syncLiveCompany();
  const parsed = body.safeParse(await jsonBody(request));
  if (!parsed.success)
    return badRequest("Expected type swap_transfer, standard nep413, signerId and depositAddress.");
  return railResponse(await (await payoutRail()).generateIntent(parsed.data));
}
