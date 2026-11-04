import type { AccountId } from "@homeroll/shared";
import type { KeyPermission, ProtocolFailureName } from "./client";

/**
 * What NEAR checks before a transaction signed with a function-call key is included (SPEC §6),
 * in the protocol's order. The fake chain uses it to show attack 05; on testnet the RPC returns
 * the same names as `InvalidTxError::InvalidAccessKeyError(...)` and none of our code runs.
 */
export interface TxShape {
  receiverId: AccountId;
  actions: {
    type: "FunctionCall" | "Transfer" | "AddKey";
    methodName?: string;
    depositYocto: bigint;
  }[];
}

export function checkAccessKey(permission: KeyPermission, tx: TxShape): ProtocolFailureName | null {
  if (permission.kind === "FullAccess") return null;
  const [action, ...rest] = tx.actions;
  // 1. More than one action, or an action that is not a function call
  if (!action || rest.length > 0 || action.type !== "FunctionCall") return "RequiresFullAccess";
  // 2. Any attached deposit (so ft_transfer's 1 yocto can never be paid with this key)
  if (action.depositYocto > 0n) return "DepositWithFunctionCall";
  // 3. Receiver differs from the key's receiver_id
  if (tx.receiverId !== permission.receiverId) return "ReceiverMismatch";
  // 4. Method not in method_names (an empty list allows any method)
  if (
    permission.methodNames.length > 0 &&
    !permission.methodNames.includes(action.methodName ?? "")
  ) {
    return "MethodNameMismatch";
  }
  return null;
}
