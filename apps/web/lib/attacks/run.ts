import { existsSync } from "node:fs";
import { join } from "node:path";
import { getChainClient } from "@/lib/near";
import { loadEnvLocal } from "@/lib/seed/shell";
import { ATTACK_IDS, type AttackId, runAttack } from "./index";

export { ATTACK_IDS, type AttackId };

/** SPEC §11. Exit 0 only when every attack is refused and moves no money. */
export async function runAll(): Promise<number> {
  if (process.env.ATTACKS_CHAIN === "near") applyNearEnv();
  else process.env.CHAIN_CLIENT = "fake";
  for (const id of ATTACK_IDS) {
    const code = await runPrinted(id);
    if (code !== 0) return code;
  }
  return 0;
}

/**
 * SPEC §11. Same `runAttack` the lab calls.
 * Fake runs reset the in-memory company first. Testnet does not. Reset would mint a new employer.
 */
export async function runPrinted(id: AttackId): Promise<number> {
  const chain = getChainClient();
  if (chain.network === "fake") await chain.resetDemo();
  const result = await runAttack(id);
  const unchanged = result.money.afterSen === result.money.beforeSen;
  const refused = result.failures.length > 0 && unchanged;
  console.log(
    JSON.stringify({
      id: result.id,
      chain: chain.network,
      proposed: result.proposed,
      stoppedBy: result.stoppedBy,
      errors: result.failures.map((failure) => ({
        code: failure.code,
        sentence: failure.sentence,
      })),
      notes: result.notes,
      money: {
        label: result.money.label,
        beforeSen: result.money.beforeSen,
        afterSen: result.money.afterSen,
      },
      simulated: result.simulated,
      transaction: result.simulated
        ? "none. The fake chain checked the key locally."
        : result.id === "05"
          ? "NEAR rejected the signed transaction before it was included."
          : result.id === "06"
            ? "No pay_run was sent: the payout rail refused first."
            : "The contract panicked after inclusion. No money moved.",
      outcome: refused ? "refused" : "unexpected",
    }),
  );
  return refused ? 0 : 1;
}

function applyNearEnv(): void {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const record = loadEnvLocal(path);
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && process.env[key] === undefined) process.env[key] = value;
  }
  process.env.CHAIN_CLIENT = "near";
}
