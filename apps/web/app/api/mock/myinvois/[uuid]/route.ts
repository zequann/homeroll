import type { NextRequest } from "next/server";
import { mockMyInvois } from "@/lib/agents/myinvois";
import { getFixtures } from "@/lib/near";

/** LHDN MyInvois, mocked (SPEC §8.6). */
export async function GET(_request: NextRequest, ctx: { params: Promise<{ uuid: string }> }) {
  const { uuid } = await ctx.params;
  const record = await mockMyInvois(getFixtures()).getDocument(uuid);
  if (!record) return Response.json({ mock: true, reason: "no_record" }, { status: 404 });
  return Response.json(record);
}
