import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountId } from "@homeroll/shared";

export type BlobId = string & { readonly __blob: "BlobId" };
export type UtcDay = string & { readonly __utcDay: "UtcDay" };
export type ClaimPhase = "held" | "landed" | "dropped";

export type Claim = {
  blob: BlobId;
  day: UtcDay;
  amount: bigint;
  maxBlockHeight: bigint;
  phase: ClaimPhase;
  txHash: string | null;
};

export type WorkerBook = {
  find(blob: BlobId): Claim | null;
  spentUnits(day: UtcDay, blockHeight: bigint): bigint;
  relayCount(day: UtcDay): number;
  hold(claim: Omit<Claim, "phase" | "txHash">): void;
  land(blob: BlobId, txHash: string): void;
  drop(blob: BlobId): void;
};

type StoredClaim = {
  blob: BlobId;
  day: UtcDay;
  amount: string;
  maxBlockHeight: string;
  phase: ClaimPhase;
  txHash: string | null;
};

function createBook(claims: Claim[]): WorkerBook {
  const list = claims;
  return {
    find(blob) {
      return list.find((c) => c.blob === blob) ?? null;
    },
    spentUnits(day, blockHeight) {
      let sum = 0n;
      for (const c of list) {
        if (c.day !== day) continue;
        if (c.phase !== "held" && c.phase !== "landed") continue;
        if (c.phase === "held" && c.maxBlockHeight <= blockHeight) continue;
        sum += c.amount;
      }
      return sum;
    },
    relayCount(day) {
      return list.filter(
        (c) =>
          c.day === day && (c.phase === "held" || c.phase === "landed" || c.phase === "dropped"),
      ).length;
    },
    hold(claim) {
      list.push({ ...claim, phase: "held", txHash: null });
    },
    land(blob, txHash) {
      const c = list.find((x) => x.blob === blob);
      if (!c) throw new Error("claim missing");
      c.phase = "landed";
      c.txHash = txHash;
    },
    drop(blob) {
      const c = list.find((x) => x.blob === blob);
      if (!c) throw new Error("claim missing");
      c.phase = "dropped";
      c.txHash = null;
    },
  };
}

function serialize(claims: Claim[]): string {
  const stored: StoredClaim[] = claims.map((c) => ({
    blob: c.blob,
    day: c.day,
    amount: c.amount.toString(),
    maxBlockHeight: c.maxBlockHeight.toString(),
    phase: c.phase,
    txHash: c.txHash,
  }));
  return `${JSON.stringify(stored, null, 2)}\n`;
}

function deserialize(raw: string): Claim[] {
  const parsed = JSON.parse(raw) as StoredClaim[];
  return parsed.map((c) => ({
    blob: c.blob as BlobId,
    day: c.day as UtcDay,
    amount: BigInt(c.amount),
    maxBlockHeight: BigInt(c.maxBlockHeight),
    phase: c.phase,
    txHash: c.txHash,
  }));
}

export class ExposureLog {
  private readonly memory = new Map<AccountId, Claim[]>();
  private readonly locks = new Map<AccountId, Promise<void>>();
  readonly inFlight = new Set<BlobId>();

  private constructor(private readonly dir: string | null) {}

  static memory(): ExposureLog {
    return new ExposureLog(null);
  }

  static files(dir: string): ExposureLog {
    return new ExposureLog(dir);
  }

  private async load(worker: AccountId): Promise<Claim[]> {
    if (this.dir === null) {
      return this.memory.get(worker) ?? [];
    }
    const path = join(this.dir, `${worker}.json`);
    try {
      return deserialize(await readFile(path, "utf8"));
    } catch {
      return [];
    }
  }

  private async save(worker: AccountId, claims: Claim[]): Promise<void> {
    if (this.dir === null) {
      this.memory.set(worker, claims);
      return;
    }
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${worker}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, serialize(claims), "utf8");
    await rename(tmp, path);
  }

  async withWorker<T>(worker: AccountId, fn: (book: WorkerBook) => T): Promise<T> {
    const prev = this.locks.get(worker) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      worker,
      prev.then(() => gate),
    );
    await prev;
    try {
      const claims = await this.load(worker);
      const book = createBook(claims);
      const result = fn(book);
      await this.save(worker, claims);
      return result;
    } finally {
      release();
    }
  }
}

export function utcDay(now: Date): UtcDay {
  return now.toISOString().slice(0, 10) as UtcDay;
}

export function blobId(raw: Uint8Array): BlobId {
  return createHash("sha256").update(raw).digest("hex") as BlobId;
}
