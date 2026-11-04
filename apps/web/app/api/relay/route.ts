import { homerollAccounts } from "@homeroll/shared";
import { z } from "zod";
import { deriveKey } from "@/lib/keys";
import { accessKey, blockHeight, configureRpc, submitDelegate } from "@/lib/near/rpc";
import { ExposureLog } from "@/lib/relay/exposure";
import { type RelayResponse, relay } from "@/lib/relay/relay";

const bodySchema = z.object({ signedDelegate: z.string() }).strict();

export function toResponse(result: RelayResponse): Response {
  return Response.json(result.body, { status: result.status });
}

export async function POST(request: Request): Promise<Response> {
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
  const exposure = ExposureLog.files(".data/relay");
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
