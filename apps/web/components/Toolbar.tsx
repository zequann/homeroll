"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { type Surface, surfacesFor } from "@/lib/access";
import styles from "./Toolbar.module.css";
import { WalletButton } from "./WalletButton";
import { useWallet } from "./WalletProvider";

const NAV: readonly { surface: Surface; href: string; label: string }[] = [
  { surface: "owner", href: "/owner", label: "Owner" },
  { surface: "worker", href: "/worker", label: "Worker" },
  { surface: "lab", href: "/lab", label: "Lab" },
  { surface: "lender", href: "/lender", label: "Lender" },
];

/** Sticky translucent toolbar. Content scrolls under it; a hairline appears once the page has scrolled. */
export function Toolbar({ modeLabel }: { modeLabel: string }) {
  const pathname = usePathname();
  // A connected wallet sees only its own pages (lib/access); with none, every page shows
  const allowed = surfacesFor(useWallet().connected?.role ?? null);
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
            {NAV.filter((item) => allowed.includes(item.surface)).map((item) => (
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
          <span className={styles.pillWrap}>
            <button
              type="button"
              className={`${styles.pill} t-caption`}
              aria-describedby="demo-mode-tip"
            >
              {modeLabel}
            </button>
            <span id="demo-mode-tip" className={styles.tip} role="tooltip">
              The server holds the demo keys and signs for you (SPEC D7).
            </span>
          </span>
          <WalletButton />
        </div>
      </header>
    </>
  );
}
