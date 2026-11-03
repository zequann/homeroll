"use client";

import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { formatRmDigits, type Sen } from "@/lib/fx";
import styles from "./Money.module.css";

/**
 * A number that rolls to its new value after the user's own action (treasury, worker balance).
 * Only the digits roll. Reduced motion swaps the number without rolling.
 */
export function RollingMoney({
  value,
  decimals,
  hang,
}: {
  value: Sen;
  decimals?: 0 | 2;
  hang?: boolean;
}) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState<number>(value);
  const from = useRef<number>(value);

  useEffect(() => {
    if (reduced || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    // Start from what is on screen, not the old target, so an interrupted roll carries on.
    const controls = animate(from.current, value, {
      type: "spring",
      bounce: 0,
      visualDuration: 0.6,
      onUpdate: (v) => {
        from.current = v;
        setShown(Math.round(v));
      },
      onComplete: () => {
        from.current = value;
        setShown(value);
      },
    });
    return () => controls.stop();
  }, [value, reduced]);

  const places = decimals ?? (value % 100 === 0 ? 0 : 2);
  return (
    <span className={styles.money}>
      <span className="sr-only">RM{formatRmDigits(value, places)}</span>
      <span className={hang ? styles.hung : styles.prefix} aria-hidden>
        RM
      </span>
      <span aria-hidden>{formatRmDigits(shown as Sen, places)}</span>
    </span>
  );
}
