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

/** Mock sign-in (SPEC §9.2). The code is fixed and shown on screen: no SMS is sent to anyone. */
const MOCK_OTP = "123456";

export async function signInWorker(code: unknown): Promise<{ ok: boolean }> {
  if (z.string().parse(code).trim() !== MOCK_OTP) return { ok: false };
  await writeSession("worker:w-7k2q9x");
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function disconnect(): Promise<void> {
  await writeSession(null);
  revalidatePath("/", "layout");
}
