import { syncLiveCompany } from "@/lib/near";
import { badRequest, railResponse } from "@/lib/payout/http";
import { payoutRail } from "@/lib/payout/server";

/** Mock 1Click `GET /v0/status?depositAddress=` (SPEC §8.11). Hashes are public testnet payouts. */
export async function GET(request: Request): Promise<Response> {
  await syncLiveCompany();
  const depositAddress = new URL(request.url).searchParams.get("depositAddress");
  if (!depositAddress) return badRequest("depositAddress is required.");
  return railResponse(await (await payoutRail()).status(depositAddress));
}
