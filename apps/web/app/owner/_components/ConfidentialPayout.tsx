import { Badge } from "@/components/Badge";
import { formatRm } from "@/lib/fx";
import type { PayoutPanelView } from "@/lib/payout/server";
import styles from "./payout.module.css";

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

/**
 * Payday through the mocked Confidential Intents payout rail (SPEC §8.11, §9.1). The badge names
 * the mock (CLAUDE.md rule 7); the panel shows what happened, not how production would differ.
 */
export function ConfidentialPayout({
  payout,
  network,
}: {
  payout: PayoutPanelView | null;
  network: "fake" | "testnet";
}) {
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
              <li key={hash}>{txLink(network, hash)}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="t-caption ink-2">
          Run payroll asks the owner to sign a payout intent. Nothing is paid until the payout rail
          has checked it.
        </p>
      )}
    </section>
  );
}
