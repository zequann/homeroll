"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-reads the page every 2 seconds while the tab is visible, so a wage shows within seconds of Run payroll. */
export function RefreshWhileVisible({ everyMs = 2000 }: { everyMs?: number }) {
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
