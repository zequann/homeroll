"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Money } from "@/components/Money";
import type { Sen } from "@/lib/fx";
import styles from "./worker.module.css";

export interface WorkerActivityItem {
  id: string;
  label: string;
  /** Positive = received, negative = sent. */
  amountSen: Sen;
}

/** New rows slide in from the top of the list. The first paint does not animate. */
export function ActivityList({ items }: { items: WorkerActivityItem[] }) {
  const reduced = useReducedMotion();
  if (items.length === 0) return <p className="ink-3">No activity yet.</p>;
  return (
    <ul className={styles.activity}>
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <motion.li
            key={item.id}
            className={styles.activityRow}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={
              reduced ? { duration: 0.15 } : { type: "spring", bounce: 0, visualDuration: 0.35 }
            }
          >
            <span>{item.label}</span>
            <span className={item.amountSen > 0 ? styles.plus : undefined}>
              {item.amountSen > 0 ? "+" : "−"}
              <Money value={Math.abs(item.amountSen) as Sen} decimals={2} />
            </span>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}
