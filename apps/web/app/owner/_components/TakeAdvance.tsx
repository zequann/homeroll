"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/Button";
import { ContractErrorNote } from "@/components/ContractErrorNote";
import type { FailureView } from "@/lib/describe-failure";
import { takeAdvance } from "../actions";

export function TakeAdvance({ number }: { number: string }) {
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<FailureView | null>(null);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-2)",
        alignItems: "flex-end",
      }}
    >
      <Button
        variant="tinted"
        size="small"
        pending={pending}
        pendingLabel="Requesting…"
        onClick={() =>
          start(async () => {
            setFailure(null);
            const result = await takeAdvance(number);
            if (!result.ok && result.reason === "rejected") setFailure(result.failure);
          })
        }
      >
        Take advance
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
