"use client";

import {
  AnimatePresence,
  animate,
  motion,
  type PanInfo,
  useDragControls,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import { type ReactNode, type RefObject, useEffect, useRef, useSyncExternalStore } from "react";
import styles from "./Sheet.module.css";

const PHONE_QUERY = "(max-width: 639px)";
const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const usePhone = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );

/** Apple's projection: where a flick would come to rest (design 2.4, apple-design §6). */
const project = (velocity: number, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate);

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** The element that opened the sheet. Focus returns to it on close. */
  triggerRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * Modal sheet. Desktop: grows from the wallet button (top right) and shrinks back into it.
 * Phone: rises from the bottom, can be dragged down, leaves through the bottom.
 * Escape and a tap on the scrim close it; focus is trapped and returned.
 */
export function Sheet({ open, onClose, title, triggerRef, children }: SheetProps) {
  const phone = usePhone();
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const y = useMotionValue(0);
  const dragControls = useDragControls();

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef?.current ?? (document.activeElement as HTMLElement | null);
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      trigger?.focus?.();
    };
  }, [open, onClose, triggerRef]);

  const spring = { type: "spring", bounce: 0, visualDuration: 0.35 } as const;
  const fade = { duration: 0.15 } as const;

  const variants = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : phone
      ? { initial: { y: "100%" }, animate: { y: 0 }, exit: { y: "100%" } }
      : {
          initial: { opacity: 0, scale: 0.92 },
          animate: { opacity: 1, scale: 1 },
          exit: { opacity: 0, scale: 0.92 },
        };

  const onDragEnd = (_: PointerEvent, info: PanInfo) => {
    const height = panel.current?.offsetHeight ?? 0;
    // Dismiss if the projected resting point is past half the sheet, else spring back with the release velocity.
    if (info.offset.y + project(info.velocity.y) > height / 2) {
      onClose();
      return;
    }
    animate(y, 0, { type: "spring", bounce: 0.2, visualDuration: 0.35, velocity: info.velocity.y });
  };

  return (
    <AnimatePresence
      onExitComplete={() => {
        y.set(0);
      }}
    >
      {open ? (
        <motion.div
          key="scrim"
          className={styles.scrim}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fade}
          onPointerDown={onClose}
        />
      ) : null}
      {open ? (
        <motion.div
          key="sheet"
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          className={phone ? styles.bottom : styles.anchored}
          style={phone && !reduced ? { y } : undefined}
          {...variants}
          transition={reduced ? fade : spring}
          drag={phone && !reduced ? "y" : false}
          dragControls={dragControls}
          dragListener={false}
          dragMomentum={false}
          dragElastic={0}
          dragConstraints={{ top: 0, bottom: 0 }}
          onDragEnd={onDragEnd}
        >
          {phone ? (
            <div
              className={styles.grabber}
              onPointerDown={(e) => dragControls.start(e)}
              aria-hidden
            >
              <span />
            </div>
          ) : null}
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
