"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { labelAction } from "@/lib/activity";
import { ATTACK_IDS, type AttackResult, runAttack as run } from "@/lib/attacks";
import { syncLiveCompany } from "@/lib/near";

export type { AttackResult };

/**
 * Runs an attack against the current demo company (SPEC §9.3). The server signs as the agent
 * keys the real flows use, so no wallet is needed.
 */
export async function runAttack(id: unknown): Promise<AttackResult> {
  await syncLiveCompany();
  const attackId = z.enum(ATTACK_IDS).parse(id);
  labelAction(`Attack ${attackId}`);
  const result = await run(attackId);
  revalidatePath("/owner");
  revalidatePath("/lab");
  revalidatePath("/lender");
  return result;
}
