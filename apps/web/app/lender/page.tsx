import { PlaceholderRow } from "@/components/PlaceholderRow";
import { formatUsdc, units } from "@/lib/fx";
import { getChainClient } from "@/lib/near";
import styles from "./lender.module.css";

export const metadata = { title: "Lender · Homeroll" };

/** Pool numbers in USDC. USDC is the only currency on this page, with no RM hint. */
export default async function LenderPage() {
  const pool = await getChainClient().getPool();
  const total = units(pool.cash + pool.outstanding);

  return (
    <main className="page">
      <div className={styles.stack}>
        <h1 className="sr-only">Lender</h1>
        <section className={styles.card} aria-labelledby="pool-label">
          <p id="pool-label" className="t-caption ink-3">
            Pool
          </p>
          <p className={`t-display ${styles.total}`}>{formatUsdc(total)}</p>
          <dl className={styles.figures}>
            <div>
              <dt className="t-caption ink-3">Available</dt>
              <dd>{formatUsdc(pool.cash)}</dd>
            </div>
            <div>
              <dt className="t-caption ink-3">Lent to employers</dt>
              <dd>{formatUsdc(pool.outstanding)}</dd>
            </div>
            <div>
              <dt className="t-caption ink-3">Fees earned</dt>
              <dd>{formatUsdc(pool.feesEarned)}</dd>
            </div>
          </dl>
        </section>

        <section className={`${styles.card} ${styles.quiet}`} aria-label="Not in this build">
          <PlaceholderRow name="Deposit" caption="Not in this build (SPEC §9.4, P1)." />
          <PlaceholderRow
            name="Deposit from any chain"
            caption="Not in this build (SPEC §9.4, P1)."
          />
          <PlaceholderRow name="Rhea Lend rate" caption="Not in this build (SPEC §9.4, P1)." />
        </section>
      </div>
    </main>
  );
}
