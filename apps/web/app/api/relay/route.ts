import { join } from "node:path";
import { homerollAccounts } from "@homeroll/shared";
import { z } from "zod";
import { deriveKey } from "@/lib/keys";
import { syncLiveCompany } from "@/lib/near";
import { accessKey, blockHeight, configureRpc, submitDelegate } from "@/lib/near/rpc";
import { ExposureLog } from "@/lib/relay/exposure";
import { type RelayResponse, relay } from "@/lib/relay/relay";
import { rowStore } from "@/lib/store/rows";

const bodySchema = z.object({ signedDelegate: z.string() }).strict();

// One log per process. A fresh log per request would not share the in-flight set. With Supabase the
// claims are shared by every instance (Vercel's file system is read-only); without it, local files.
const exposure =
  rowStore().kind === "supabase"
    ? ExposureLog.rows(rowStore())
    : ExposureLog.files(join(process.cwd(), ".data", "relay"));

export function toResponse(result: RelayResponse): Response {
  return Response.json(result.body, { status: result.status });
}

export async function POST(request: Request): Promise<Response> {
  await syncLiveCompany();
  if (process.env.NEAR_NETWORK !== "testnet") {
    return Response.json({ reason: "network_refused" }, { status: 503 });
  }
  const root = process.env.NEAR_ROOT_ACCOUNT;
  const seed = process.env.SERVER_KEY_SEED?.trim();
  if (!root || !seed) {
    return Response.json({ reason: "relayer_key_missing" }, { status: 503 });
  }
  const rpcUrl = process.env.NEAR_RPC_URL;
  if (rpcUrl) configureRpc(rpcUrl);

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ rule: "one_action" }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ rule: "one_action" }, { status: 403 });
  }

  const accounts = homerollAccounts(root);
  const relayer = deriveKey(seed, accounts.relayer, "relayer");
  const result = await relay(parsed.data.signedDelegate, {
    accounts,
    now: () => new Date(),
    blockHeight,
    accessKey,
    exposure,
    relayer,
    submit: submitDelegate,
  });
  return toResponse(result);
}
