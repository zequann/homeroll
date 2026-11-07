import { Money } from "@/components/Money";
import type { ActivityRow } from "@/lib/views/owner";
import styles from "./owner.module.css";

/** Newest first. Hashes are fake in fake mode, so only testnet rows get an explorer link. */
export function Activity({ rows }: { rows: ActivityRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="ink-3">Nothing yet. Run payroll or take an advance and it shows up here.</p>
    );
  }
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Button</th>
            <th scope="col">Method</th>
            <th scope="col">From → to</th>
            <th scope="col" className={styles.num}>
              Amount
            </th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="ink-2">{row.when}</td>
              <td>{row.button ?? <span className="ink-3">None</span>}</td>
              <td className="t-mono">{row.method}</td>
              <td className="t-mono ink-3">
                {row.from} → {row.to}
              </td>
              <td className={styles.num}>
                {row.usdc ? (
                  <>
                    <div>{row.usdc}</div>
                    {row.rmHint !== null ? (
                      <div className="t-caption ink-3">
                        ≈ <Money value={row.rmHint} decimals={2} />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <span className="ink-3">None</span>
                )}
              </td>
              <td>
                {row.failure ? (
                  <>
                    <span className={styles.bad}>Failed</span>
                    <div className={`t-mono ${styles.bad}`}>{row.failure}</div>
                  </>
                ) : (
                  <span className={styles.ok}>Success</span>
                )}
                {row.explorerUrl && row.txHash ? (
                  <div className="t-caption">
                    <a
                      className="link t-mono"
                      href={row.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Transaction ${row.txHash} on NearBlocks (opens in a new tab)`}
                    >
                      {row.txHash.slice(0, 10)}… on NearBlocks
                    </a>
                  </div>
                ) : row.txHash ? (
                  <div className="t-caption t-mono ink-3">{row.txHash}</div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
