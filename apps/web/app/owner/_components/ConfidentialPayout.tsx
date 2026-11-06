"use client";

import { useState } from "react";
import { Badge } from "@/components/Badge";
import { formatRm } from "@/lib/fx";
import type { PayoutPanelView } from "@/lib/payout/server";
import styles from "./payout.module.css";

/** What an outsider sees, step by step (SPEC §8.11 table). */
const VIEWS = {
  demo: [
    ["Run check", "submit_run with every pay line and amount."],
    ["Funding", "Owner → payroll treasury, with the amount."],
    ["Payday", "pay_run: payroll → each worker, with amounts, on NearBlocks."],
    ["Send home / Cash out", "Worker → payout partner, with the amount."],
  ],
  production: [
    [
      "Run check",
      "The same, while the payroll contract runs on the public chain. Whether it can run on the private shard is an open question.",
    ],
    ["Funding", "Owner → its confidential balance, with the amount."],
    ["Payday", "Nothing."],
    [
      "Send home / Cash out",
      "An amount leaving the Confidential Intents treasury, not linkable to the worker.",
    ],
  ],
} as const;

const STATUS_TEXT = {
  PENDING_DEPOSIT: "Quoted, waiting for the owner's signature",
  PROCESSING: "Approved, paying",
  SUCCESS: "Paid",
  REFUNDED: "Run cancelled, money back in the treasury",
  FAILED: "A line failed and its money went back to the treasury",
} as const;

function txLink(network: "fake" | "testnet", hash: string) {
  if (network !== "testnet") return <span className="t-mono">{hash}</span>;
  return (
    <a
      className="t-mono"
      href={`https://testnet.nearblocks.io/txns/${hash}`}
      target="_blank"
      rel="noreferrer"
    >
      {hash.slice(0, 12)}…
    </a>
  );
}

/** Payday through the mocked Confidential Intents payout rail (SPEC §8.11, §9.1). */
export function ConfidentialPayout({
  payout,
  network,
}: {
  payout: PayoutPanelView | null;
  network: "fake" | "testnet";
}) {
  const [view, setView] = useState<"demo" | "production">("demo");

  return (
    <section className={styles.panel} aria-labelledby="payout-title">
      <div className={styles.head}>
        <h2 id="payout-title" className="t-headline">
          Payout
        </h2>
        <Badge>Confidential layer: simulated</Badge>
      </div>

      {payout ? (
        <div className={styles.status}>
          <p>
            {STATUS_TEXT[payout.status]} · {payout.lineCount} transfer intents ·{" "}
            {formatRm(payout.amountSen, { decimals: 2 })}
          </p>
          <p className="t-caption ink-3">
            Payout intent <span className="t-mono">{payout.intentHash.slice(0, 16)}…</span>, signed
            by the owner (NEP-413) and checked by the payout rail.
          </p>
          <ul className={styles.hashes}>
            {payout.nearTxHashes.map((hash) => (
              <li key={hash}>
                {txLink(network, hash)}
                <span className="t-caption ink-3">
                  Simulated. In production this settles on NEAR's private shard.
                  {network === "testnet" ? " Testnet transaction, publicly visible." : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="t-caption ink-2">
          Run payroll asks the owner to sign a payout intent. Nothing is paid until the payout rail
          has checked it.
        </p>
      )}

      <fieldset className={styles.toggle}>
        <legend className="sr-only">What an outsider sees</legend>
        <button type="button" aria-pressed={view === "demo"} onClick={() => setView("demo")}>
          This demo
        </button>
        <button
          type="button"
          aria-pressed={view === "production"}
          onClick={() => setView("production")}
        >
          Production
        </button>
      </fieldset>
      <dl className={styles.views}>
        {VIEWS[view].map(([step, seen]) => (
          <div key={step}>
            <dt className="t-caption ink-3">{step}</dt>
            <dd>{seen}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
