"use client";

import { useState } from "react";
import { ActionFailed } from "@/components/ActionFailed";
import { Button } from "@/components/Button";
import { ContractErrorNote } from "@/components/ContractErrorNote";
import { useActionTransition } from "@/components/useActionTransition";
import type { FailureView } from "@/lib/describe-failure";
import { payMissed } from "../actions";

/** Pay missed worker: a one-line run for the same period (SPEC §9.1). */
export function PayMissed({ accountId }: { accountId: string }) {
  const [pending, start, failed] = useActionTransition();
  const [failure, setFailure] = useState<FailureView | null>(null);
  return (
    <div>
      <Button
        variant="tinted"
        size="small"
        pending={pending}
        pendingLabel="Paying…"
        onClick={() =>
          start(async () => {
            setFailure(null);
            const result = await payMissed(accountId);
            if (!result.ok && result.reason === "rejected") setFailure(result.failure);
          })
        }
      >
        Pay missed worker
      </Button>
      <ActionFailed show={failed} />
      {failure ? (
        <ContractErrorNote
          sentence={failure.sentence}
          code={failure.code}
          ruleCaption={failure.ruleCaption}
        />
      ) : null}
    </div>
  );
}
