import { revalidatePath } from "next/cache";
import { resetDemoEverywhere } from "@/lib/demo-reset";

/** SPEC §9.6 asks for a rate limit. In-process is enough for the fake chain's single company. */
const COOLDOWN_MS = 5_000;
const globalForReset = globalThis as unknown as { __homerollLastReset?: number };

export async function POST(): Promise<Response> {
  const now = Date.now();
  const last = globalForReset.__homerollLastReset ?? 0;
  if (now - last < COOLDOWN_MS) return Response.json({ reason: "too_soon" }, { status: 429 });
  globalForReset.__homerollLastReset = now;
  const { employer } = await resetDemoEverywhere();
  revalidatePath("/", "layout");
  return Response.json({ employer });
}
