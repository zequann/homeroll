import { describe, expect, it } from "vitest";
import { createActivityLog, labelAction } from "./activity";

const entry = {
  at: 0,
  method: "request_advance",
  from: "owner.testnet",
  to: "pool.testnet",
  amount: null,
  txHash: "abc",
  failure: null,
};

/** Runs `work` in its own async context, as each server request does. */
const inRequest = (work: () => void) =>
  new Promise<void>((resolve) =>
    setImmediate(() => {
      work();
      resolve();
    }),
  );

describe("activity log", () => {
  it("labels entries with the button that started the request, and no other request", async () => {
    const log = createActivityLog();
    await inRequest(() => {
      labelAction("Take advance");
      log.record(entry);
    });
    await inRequest(() => log.record(entry));
    const [outside, inside] = log.list();
    expect(inside?.action).toBe("Take advance");
    expect(outside?.action).toBeNull();
  });

  it("keeps an explicit label", async () => {
    const log = createActivityLog();
    await inRequest(() => {
      labelAction("Run payroll");
      log.record({ ...entry, action: "Attack 06" });
    });
    expect(log.list()[0]?.action).toBe("Attack 06");
  });
});
