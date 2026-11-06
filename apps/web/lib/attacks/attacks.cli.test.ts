import { expect, it } from "vitest";
import { runAll } from "./run";

it(
  "refuses all five attacks and moves no money",
  async () => {
    expect(await runAll()).toBe(0);
  },
  process.env.ATTACKS_CHAIN === "near" ? 180_000 : 5_000,
);
