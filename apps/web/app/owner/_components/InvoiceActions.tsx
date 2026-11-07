"use client";

import { useTransition } from "react";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { buyerPaid, checkInvoice } from "../actions";

const column = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--s-2)",
  alignItems: "flex-end",
} as const;

/** Owner "uploads" the invoice; the agent checks, grades and registers it (SPEC §8.1). */
export function CheckInvoice({ number }: { number: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="tinted"
      size="small"
      pending={pending}
      pendingLabel="Checking…"
      onClick={() =>
        start(async () => {
          await checkInvoice(number);
        })
      }
    >
      Check with agent
    </Button>
  );
}

/** The buyer pays into the mock bank's escrow, which settles the invoice on the pool. */
export function BuyerPaid({ number }: { number: string }) {
  const [pending, start] = useTransition();
  return (
    <div style={column}>
      <Button
        variant="plain"
        size="small"
        pending={pending}
        pendingLabel="Settling…"
        onClick={() =>
          start(async () => {
            await buyerPaid(number);
          })
        }
      >
        Buyer paid
      </Button>
      <Badge>Mock bank</Badge>
    </div>
  );
}
