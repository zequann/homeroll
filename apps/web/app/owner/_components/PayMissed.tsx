"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/Button";
import { ContractErrorNote } from "@/components/ContractErrorNote";
import type { FailureView } from "@/lib/describe-failure";
import { payMissed } from "../actions";

/** Pay missed worker: a one-line run for the same period (SPEC §9.1). */
export function PayMissed({ accountId, connected }: { accountId: string; connected: boolean }) {
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<FailureView | null>(null);
  if (!connected) return null;
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
