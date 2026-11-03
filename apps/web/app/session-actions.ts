"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeSession } from "@/lib/session";

const key = z.enum(["owner", "worker:w-7k2q9x", "lender"]);

/** Picks which demo account the server signs as. Sets a cookie; no key reaches the browser. */
export async function connect(account: unknown): Promise<void> {
  await writeSession(key.parse(account));
  revalidatePath("/", "layout");
}

export async function disconnect(): Promise<void> {
  await writeSession(null);
  revalidatePath("/", "layout");
}
