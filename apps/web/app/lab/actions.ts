"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ATTACK_IDS, type AttackResult, runAttack as run } from "@/lib/attacks";

export type { AttackResult };

/**
 * Runs an attack against the current demo company (SPEC §9.3). The server signs as the agent
 * keys the real flows use, so no wallet is needed.
 */
export async function runAttack(id: unknown): Promise<AttackResult> {
  const result = await run(z.enum(ATTACK_IDS).parse(id));
  revalidatePath("/owner");
  revalidatePath("/lab");
  revalidatePath("/lender");
  return result;
}
