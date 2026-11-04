import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = join(import.meta.dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

describe("near-api-js import fence", () => {
  it("allows near-api-js only in rpc.ts", () => {
    const offenders: string[] = [];
    for (const file of walk(WEB_ROOT)) {
      if (file.endsWith("lib/near/rpc.ts")) continue;
      const text = readFileSync(file, "utf8");
      if (/from\s+["']near-api-js["']/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps relay route off deploy and proof entrypoints", () => {
    const routeDir = join(WEB_ROOT, "app/api/relay");
    const text = walk(routeDir)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(text).not.toMatch(/planMint|planCreateWorker|broadcastAdmin|proveGaslessTransfer/);
  });

  it("calls submitDelegate only from rpc.ts", () => {
    const callers: string[] = [];
    for (const file of walk(WEB_ROOT)) {
      const text = readFileSync(file, "utf8");
      if (/submitDelegate\s*\(/.test(text) && !file.endsWith("lib/near/rpc.ts")) {
        callers.push(file);
      }
    }
    expect(callers).toEqual([]);
  });
});
