import { z } from "zod";
import { getFixtures, syncLiveCompany } from "@/lib/near";
import { period } from "@/lib/near/client";
import { badRequest, jsonBody, railResponse } from "@/lib/payout/http";
import { payoutRail } from "@/lib/payout/server";

const body = z.object({
  depositType: z.literal("CONFIDENTIAL_INTENTS"),
  recipientType: z.literal("CONFIDENTIAL_INTENTS"),
  refundTo: z.string(),
  /** Homeroll's own field: which reserved payroll run to pay. 1Click has no runs. */
  payrollRun: z.object({ period: z.string(), runId: z.number().int().nonnegative() }),
});

/** Mock 1Click `POST /v0/quote` in confidential mode (SPEC §8.11). Reads the run; moves nothing. */
export async function POST(request: Request): Promise<Response> {
  await syncLiveCompany();
  const parsed = body.safeParse(await jsonBody(request));
  if (!parsed.success)
    return badRequest(
      "Expected CONFIDENTIAL_INTENTS deposit and recipient types, refundTo and payrollRun.",
    );
  const { refundTo, payrollRun } = parsed.data;
  // Only the current demo company, so outsiders cannot fill the rail's memory
  if (refundTo !== getFixtures().company.accountId)
    return badRequest("refundTo is not the demo employer.");
  let runPeriod: ReturnType<typeof period>;
  try {
    runPeriod = period(payrollRun.period);
  } catch {
    return badRequest("payrollRun.period must be YYYY-MM.");
  }
  return railResponse(
    await (await payoutRail()).quote({
      employer: refundTo,
      period: runPeriod,
      runId: payrollRun.runId,
    }),
  );
}
