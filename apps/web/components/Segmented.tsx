"use client";

import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import styles from "./Segmented.module.css";

export interface SegmentedItem {
  key: string;
  label: string;
  href: string;
}

/** Owner tabs. State lives in the URL (`?tab=`), so Back and reload keep the tab. */
export function Segmented({
  items,
  active,
  label,
}: {
  items: SegmentedItem[];
  active: string;
  label: string;
}) {
  const reduced = useReducedMotion();
  return (
    <nav className={styles.track} aria-label={label}>
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <Link
            key={item.key}
            href={item.href}
            scroll={false}
            replace
            className={styles.item}
            aria-current={isActive ? "page" : undefined}
          >
            {isActive ? (
              <motion.span
                layoutId="segmented-thumb"
                className={styles.thumb}
                transition={
                  reduced ? { duration: 0.15 } : { type: "spring", bounce: 0, visualDuration: 0.3 }
                }
              />
            ) : null}
            <span className={styles.text}>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
