"use client";

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { resetDemo } from "@/app/owner/actions";
import { Button } from "./Button";
import styles from "./ResetDemoButton.module.css";
import { useActionTransition } from "./useActionTransition";

const ARM_WINDOW_MS = 4000;
/** How long "Reset successful" stays under the toolbar. */
const DONE_MS = 6000;

/**
 * Reset demo (SPEC §9.6), once, in the toolbar of every page. First press arms it, a second press
 * within 4 seconds resets. Nothing is lost by one stray tap.
 */
export function ResetDemoButton({ compact = false }: { compact?: boolean }) {
  const [armed, setArmed] = useState(false);
  // Always re-reads the page after, so the fresh company shows without a reload
  const [pending, start, failed] = useActionTransition();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (doneTimer.current) clearTimeout(doneTimer.current);
    },
    [],
  );

  const press = () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), ARM_WINDOW_MS);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    if (doneTimer.current) clearTimeout(doneTimer.current);
    setArmed(false);
    setDone(false);
    // A failed reset resumes the same company next time, so pressing again is safe
    start(async () => {
      await resetDemo();
      setDone(true);
      doneTimer.current = setTimeout(() => setDone(false), DONE_MS);
    });
  };

  // Shown once the page has re-read the fresh company, not while it is still loading
  const showDone = done && !pending;

  const label = armed ? "Press again to reset" : "Reset demo";
  return (
    <span className={styles.wrap}>
      <Button
        variant="plain"
        size="small"
        icon={<ArrowCounterClockwise size={20} />}
        pending={pending}
        pendingLabel="Resetting…"
        onClick={press}
      >
        {/* Armed, the label shows on a phone too: the second press needs saying */}
        <span className={compact && !armed ? styles.compactLabel : undefined}>{label}</span>
      </Button>
      {/* Always in the page, so screen readers announce the text when it appears */}
      <span className={showDone ? `${styles.note} t-caption` : "sr-only"} role="status">
        {showDone ? "Reset successful. A fresh demo company is ready." : ""}
      </span>
      {failed ? (
        <span className={`${styles.error} t-caption ink-2`} role="alert">
          Reset demo could not finish: the testnet RPC is busy. Wait a minute, then press it again.
        </span>
      ) : null}
    </span>
  );
}
