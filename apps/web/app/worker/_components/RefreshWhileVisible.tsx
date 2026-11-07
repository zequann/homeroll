"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-reads the page every 5 seconds while the tab is visible, so a wage shows within seconds of
 * Run payroll. Each refresh is two chain reads; faster polling hits free RPC rate limits.
 */
export function RefreshWhileVisible({ everyMs = 5000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const id = setInterval(tick, everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
