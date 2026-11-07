"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { ResetDemoButton } from "./ResetDemoButton";
import styles from "./Toolbar.module.css";

const NAV = [
  { href: "/owner", label: "Owner" },
  { href: "/worker", label: "Worker" },
  { href: "/lab", label: "Lab" },
  { href: "/lender", label: "Lender" },
] as const;

/**
 * Sticky translucent toolbar. Every page is open to everyone: the demo is shared, and each page
 * signs as its own demo account on the server (lib/session). A hairline appears once the page has
 * scrolled.
 */
export function Toolbar({ modeLabel }: { modeLabel: string }) {
  const pathname = usePathname();
  const sentinel = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = sentinel.current;
    const target = bar.current;
    if (!node || !target) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) target.toggleAttribute("data-scrolled", !entry.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinel} className={styles.sentinel} aria-hidden />
      <header ref={bar} className={styles.bar}>
        <div className={styles.left}>
          <Link href="/" className={`${styles.wordmark} t-headline`}>
            Homeroll
          </Link>
          <nav className={styles.nav} aria-label="Pages">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={styles.link}
                aria-current={pathname.startsWith(item.href) ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className={styles.right}>
          <span className={`${styles.mode} t-caption ink-2`}>{modeLabel}</span>
          <ResetDemoButton compact />
        </div>
      </header>
    </>
  );
}
