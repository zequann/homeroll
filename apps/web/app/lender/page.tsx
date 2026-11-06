import { PlaceholderRow } from "@/components/PlaceholderRow";
import { depositAssets, sharesValue } from "@/lib/deposit";
import { getEnv } from "@/lib/env";
import { formatUsdc, units } from "@/lib/fx";
import { listTokens } from "@/lib/intents";
import { getChainClient, getFixtures } from "@/lib/near";
import { readSession } from "@/lib/session";
import { PrivateDeposit } from "./_components/PrivateDeposit";
import styles from "./lender.module.css";

export const metadata = { title: "Lender · Homeroll" };

const pct = (bps: bigint) => `${bps / 100n}.${String(bps % 100n).padStart(2, "0")}%`;

/** Pool numbers in USDC. USDC is the only currency on this page, with no RM hint. */
export default async function LenderPage() {
  const chain = getChainClient();
  const { lender } = getFixtures();
  const live = getEnv().intentsQuotes === "live";
  const [pool, position, session, tokens] = await Promise.all([
    chain.getPool(),
    chain.getLender(lender.accountId),
    readSession(),
    live ? listTokens() : Promise.resolve(null),
  ]);
  const total = units(pool.cash + pool.outstanding);
  const assets = depositAssets(tokens).map(({ key, label, symbol, decimals }) => ({
    key,
    label,
    symbol,
    decimals,
  }));
  const shareBps =
    position && pool.totalShares > 0n ? (position.shares * 10_000n) / pool.totalShares : 0n;

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

        <section className={styles.card} aria-labelledby="position-label">
          <p id="position-label" className="t-caption ink-3">
            Your position
          </p>
          <p className="t-headline">
            {position
              ? `${formatUsdc(sharesValue(position.shares, pool))} · ${pct(shareBps)} of the pool`
              : "No deposit yet"}
          </p>
          <p className="t-caption ink-2">
            On-chain you are <span className="t-mono">{lender.accountId}</span>. Only Homeroll's
            records know it is {lender.name}.
          </p>
        </section>

        <section className={styles.card} aria-labelledby="deposit-label">
          <p id="deposit-label" className="t-caption ink-3">
            Private deposit from any chain
          </p>
          <PrivateDeposit
            assets={assets}
            connected={session?.key === "lender"}
            network={chain.network}
          />
        </section>

        <section className={`${styles.card} ${styles.quiet}`} aria-label="Not in this build">
          <PlaceholderRow
            name="Deposit tUSDC on NEAR"
            caption="Not in this build (SPEC §9.4, P1)."
          />
          <PlaceholderRow name="Rhea Lend rate" caption="Not in this build (SPEC §9.4, P1)." />
        </section>
      </div>
    </main>
  );
}
