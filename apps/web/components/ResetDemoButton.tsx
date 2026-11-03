"use client";

import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { useEffect, useRef, useState, useTransition } from "react";
import { resetDemo } from "@/app/owner/actions";
import { Button } from "./Button";

const ARM_WINDOW_MS = 4000;

/** First press arms it, a second press within 4 seconds resets. Nothing is lost by one stray tap. */
export function ResetDemoButton() {
  const [armed, setArmed] = useState(false);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const press = () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), ARM_WINDOW_MS);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setArmed(false);
    start(async () => {
      await resetDemo();
    });
  };

  return (
    <Button
      variant="plain"
      size="small"
      icon={<ArrowCounterClockwise size={20} />}
      pending={pending}
      pendingLabel="Resetting…"
      onClick={press}
    >
      {armed ? "Press again to reset" : "Reset demo"}
    </Button>
  );
}
