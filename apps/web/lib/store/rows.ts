/**
 * Off-chain rows shared by every server instance (SPEC §8.7). On Vercel each request may run on a
 * different instance, so anything a later request must see lives here, not in process memory.
 *
 * Two backends behind one interface:
 * - Supabase, when SUPABASE_URL and SUPABASE_SECRET_KEY are set: plain PostgREST over fetch, no SDK.
 * - Memory, otherwise: local dev, the fake chain and the tests, exactly as before.
 *
 * Every table has the same shape: (scope, key) → data (jsonb). `scope` is usually the demo
 * employer, so a Reset demo starts on empty rows without deleting anything first.
 */

export const TABLES = [
  "workers",
  "invoices",
  "activity",
  "mock_ledger",
  "payouts",
  "payout_nonces",
  "relay_claims",
  "demo_company",
] as const;
export type Table = (typeof TABLES)[number];

export interface Row<T> {
  key: string;
  data: T;
}

export interface RowStore {
  readonly kind: "memory" | "supabase";
  /** Newest first, at most `limit` rows. */
  list<T>(table: Table, scope: string, limit?: number): Promise<Row<T>[]>;
  get<T>(table: Table, scope: string, key: string): Promise<T | null>;
  upsert<T>(table: Table, scope: string, key: string, data: T): Promise<void>;
  /**
   * Adds the row only if (scope, key) is new, in one step: true when this call added it. Two
   * server instances racing for the same key get exactly one `true`.
   */
  insert<T>(table: Table, scope: string, key: string, data: T): Promise<boolean>;
  /** Deletes one row. */
  remove(table: Table, scope: string, key: string): Promise<void>;
  /** Deletes every row of this scope. */
  clear(table: Table, scope: string): Promise<void>;
}

// --- JSON with bigint -------------------------------------------------------------------------
// Token amounts are bigint (CLAUDE.md rule 8). JSON has no bigint, so they travel as tagged strings.

const BIGINT_TAG = "$bigint";

export function encodeJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { [BIGINT_TAG]: v.toString() } : v)),
  );
}

export function decodeJson<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), (_k, v) =>
    v !== null &&
    typeof v === "object" &&
    Object.keys(v).length === 1 &&
    typeof v[BIGINT_TAG] === "string"
      ? BigInt(v[BIGINT_TAG])
      : v,
  ) as T;
}

// --- Memory ------------------------------------------------------------------------------------

interface MemoryRow {
  key: string;
  data: unknown;
  at: number;
}

export function createMemoryRowStore(): RowStore {
  const tables = new Map<string, Map<string, MemoryRow>>();
  let tick = 0;
  const scoped = (table: Table, scope: string) => {
    const id = `${table}\u0000${scope}`;
    let rows = tables.get(id);
    if (!rows) {
      rows = new Map();
      tables.set(id, rows);
    }
    return rows;
  };
  return {
    kind: "memory",
    async list<T>(table: Table, scope: string, limit = 1000) {
      return [...scoped(table, scope).values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, limit)
        .map((r) => ({ key: r.key, data: decodeJson<T>(r.data) }));
    },
    async get<T>(table: Table, scope: string, key: string) {
      const row = scoped(table, scope).get(key);
      return row ? decodeJson<T>(row.data) : null;
    },
    async upsert(table, scope, key, data) {
      const rows = scoped(table, scope);
      // An update keeps the row's place, as the database's created_at does
      const at = rows.get(key)?.at ?? ++tick;
      rows.set(key, { key, data: encodeJson(data), at });
    },
    async insert(table, scope, key, data) {
      const rows = scoped(table, scope);
      if (rows.has(key)) return false;
      rows.set(key, { key, data: encodeJson(data), at: ++tick });
      return true;
    },
    async remove(table, scope, key) {
      scoped(table, scope).delete(key);
    },
    async clear(table, scope) {
      scoped(table, scope).clear();
    },
  };
}

// --- Supabase (PostgREST over fetch) -----------------------------------------------------------

export interface SupabaseConfig {
  url: string;
  secretKey: string;
  fetch?: typeof fetch;
}

export class StoreUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreUnavailable";
  }
}

export function createSupabaseRowStore(config: SupabaseConfig): RowStore {
  const base = `${config.url.replace(/\/+$/, "")}/rest/v1`;
  const doFetch = config.fetch ?? fetch;
  // New `sb_secret_` keys are not JWTs: they go in `apikey` only. A legacy service_role JWT also
  // needs the bearer header.
  const headers: Record<string, string> = {
    apikey: config.secretKey,
    "Content-Type": "application/json",
    ...(config.secretKey.startsWith("sb_") ? {} : { Authorization: `Bearer ${config.secretKey}` }),
  };
  const call = async (path: string, init: RequestInit, allow: number[] = []): Promise<Response> => {
    const response = await doFetch(`${base}/${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
      cache: "no-store",
    });
    if (!response.ok && !allow.includes(response.status)) {
      const body = await response.text().catch(() => "");
      throw new StoreUnavailable(
        `Supabase ${init.method ?? "GET"} ${path.split("?")[0]}: ${response.status} ${body.slice(0, 200)}`,
      );
    }
    return response;
  };
  const eq = (v: string) => `eq.${encodeURIComponent(v)}`;
  return {
    kind: "supabase",
    async list<T>(table: Table, scope: string, limit = 1000) {
      const res = await call(
        `${table}?scope=${eq(scope)}&select=key,data&order=created_at.desc,key.desc&limit=${limit}`,
        { method: "GET" },
      );
      const rows = (await res.json()) as { key: string; data: unknown }[];
      return rows.map((r) => ({ key: r.key, data: decodeJson<T>(r.data) }));
    },
    async get<T>(table: Table, scope: string, key: string) {
      const res = await call(`${table}?scope=${eq(scope)}&key=${eq(key)}&select=data&limit=1`, {
        method: "GET",
      });
      const rows = (await res.json()) as { data: unknown }[];
      return rows[0] ? decodeJson<T>(rows[0].data) : null;
    },
    async upsert(table, scope, key, data) {
      await call(`${table}?on_conflict=scope,key`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ scope, key, data: encodeJson(data) }),
      });
    },
    async insert(table, scope, key, data) {
      // No merge: the primary key refuses a second row with 409, which is the "already taken" answer
      const res = await call(
        table,
        {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ scope, key, data: encodeJson(data) }),
        },
        [409],
      );
      return res.status !== 409;
    },
    async remove(table, scope, key) {
      await call(`${table}?scope=${eq(scope)}&key=${eq(key)}`, { method: "DELETE" });
    },
    async clear(table, scope) {
      await call(`${table}?scope=${eq(scope)}`, { method: "DELETE" });
    },
  };
}

// --- The store this server uses ----------------------------------------------------------------

const globalForRows = globalThis as unknown as { __homerollRows?: RowStore };

/** Supabase when configured, memory otherwise. Chosen once per server instance. */
export function rowStore(): RowStore {
  if (!globalForRows.__homerollRows) {
    const url = process.env.SUPABASE_URL?.trim();
    const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
    globalForRows.__homerollRows =
      url && secretKey ? createSupabaseRowStore({ url, secretKey }) : createMemoryRowStore();
  }
  return globalForRows.__homerollRows;
}

/** For tests: start over with a fresh memory store. */
export function resetRowStoreForTests(store: RowStore = createMemoryRowStore()): void {
  globalForRows.__homerollRows = store;
}
