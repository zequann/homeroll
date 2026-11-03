"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/** One place that honours the user's reduced-motion setting for every motion component. */
export function Motion({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
