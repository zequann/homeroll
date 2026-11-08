"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

/** Next's own control-flow errors (redirect, notFound) must reach the router untouched. */
function isNextControlFlow(e: unknown): boolean {
  const digest = (e as { digest?: unknown } | null)?.digest;
  return (
    typeof digest === "string" && /^NEXT_(REDIRECT|HTTP_ERROR_FALLBACK|NOT_FOUND)/.test(digest)
  );
}

/**
 * `useTransition` for buttons that call a server action. The page is always re-read afterwards,
 * even when the action throws: on testnet a busy RPC can fail a call after the chain already
 * changed (a run reserved, an advance paid), and the screen must show that without a reload.
 * A thrown action sets `failed` instead of crashing the page.
 */
export function useActionTransition(): [
  pending: boolean,
  start: (task: () => Promise<void>, onFailed?: () => void) => void,
  failed: boolean,
] {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  const start = useCallback(
    (task: () => Promise<void>, onFailed?: () => void) => {
      setFailed(false);
      startTransition(async () => {
        try {
          await task();
        } catch (e) {
          if (isNextControlFlow(e)) throw e;
          console.error(e);
          setFailed(true);
          onFailed?.();
        } finally {
          router.refresh();
        }
      });
    },
    [router],
  );

  return [pending, start, failed];
}
