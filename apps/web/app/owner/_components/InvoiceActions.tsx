"use client";

import { ActionFailed } from "@/components/ActionFailed";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { useActionTransition } from "@/components/useActionTransition";
import { buyerPaid, checkInvoice } from "../actions";

const column = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--s-2)",
  alignItems: "flex-end",
} as const;

/** Owner "uploads" the invoice; the agent checks, grades and registers it (SPEC §8.1). */
export function CheckInvoice({ number }: { number: string }) {
  const [pending, start, failed] = useActionTransition();
  return (
    <>
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
      <ActionFailed show={failed} />
    </>
  );
}

/** The buyer pays into the mock bank's escrow, which settles the invoice on the pool. */
export function BuyerPaid({ number }: { number: string }) {
  const [pending, start, failed] = useActionTransition();
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
      <ActionFailed show={failed} />
      <Badge>Mock bank</Badge>
    </div>
  );
}
