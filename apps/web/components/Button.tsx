"use client";

import Link from "next/link";
import { type ButtonHTMLAttributes, type ReactNode, useState } from "react";
import styles from "./Button.module.css";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: "primary" | "tinted" | "plain";
  size?: "regular" | "small";
  fullWidth?: boolean;
  icon?: ReactNode;
  /** Shown instead of the children while `pending`. The label changes on the same frame. */
  pendingLabel?: string;
  pending?: boolean;
}

/**
 * Responds on pointer-down: iOS Safari does not fire :active reliably, so `data-pressed` is set
 * by hand and cleared on up, cancel and leave (design 2.4).
 */
export function Button({
  variant = "primary",
  size = "regular",
  fullWidth,
  icon,
  pending,
  pendingLabel,
  children,
  onPointerDown,
  disabled,
  ...rest
}: ButtonProps) {
  const [pressed, setPressed] = useState(false);
  const clear = () => setPressed(false);
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || pending}
      data-pressed={pressed || undefined}
      className={`${styles.btn} ${styles[variant]} ${size === "small" ? styles.small : ""} ${fullWidth ? styles.full : ""}`}
      onPointerDown={(e) => {
        setPressed(true);
        onPointerDown?.(e);
      }}
      onPointerUp={clear}
      onPointerCancel={clear}
      onPointerLeave={clear}
    >
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

/** A link that looks and presses like a Button, for navigation. */
export function ButtonLink({
  href,
  variant = "primary",
  size = "regular",
  fullWidth,
  icon,
  children,
}: Pick<ButtonProps, "variant" | "size" | "fullWidth" | "icon"> & {
  href: string;
  children: ReactNode;
}) {
  const [pressed, setPressed] = useState(false);
  const clear = () => setPressed(false);
  return (
    <Link
      href={href}
      data-pressed={pressed || undefined}
      className={`${styles.btn} ${styles[variant]} ${size === "small" ? styles.small : ""} ${fullWidth ? styles.full : ""}`}
      onPointerDown={() => setPressed(true)}
      onPointerUp={clear}
      onPointerCancel={clear}
      onPointerLeave={clear}
    >
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      {children}
    </Link>
  );
}
