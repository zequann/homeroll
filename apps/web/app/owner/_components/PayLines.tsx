import { CheckCircle, Clock, XCircle } from "@phosphor-icons/react/ssr";
import { Money } from "@/components/Money";
import type { PayLineRow, PayLineStatus } from "@/lib/views/owner";
import styles from "./owner.module.css";
import { PayMissed } from "./PayMissed";

function StatusCell({ status }: { status: PayLineStatus }) {
  switch (status) {
    case "Paid":
      return (
        <span className={`${styles.statusCell} ${styles.ok}`}>
          <CheckCircle size={14} weight="fill" aria-hidden />
          Paid
        </span>
      );
    case "Reserved":
    case "Sending":
      return (
        <span className={styles.statusCell}>
          <Clock size={14} weight="fill" aria-hidden />
          {status}
        </span>
      );
    case "Failed":
      return (
        <span className={`${styles.statusCell} ${styles.bad}`}>
          <XCircle size={14} weight="fill" aria-hidden />
          Failed
        </span>
      );
    default:
      return <span className={`${styles.statusCell} ink-3`}>{status}</span>;
  }
}

/** One table, one row per pay line. Names come from Homeroll's own records; the chain sees only the account. */
export function PayLines({
  rows,
  caption = true,
  connected = false,
}: {
  rows: PayLineRow[];
  caption?: boolean;
  connected?: boolean;
}) {
  return (
    <div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Worker</th>
              <th scope="col">Role</th>
              <th scope="col" className={styles.num}>
                Net wage
              </th>
              <th scope="col" className={styles.num}>
                Wage cap
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.accountId}>
                <td>
                  <div>{row.name}</div>
                  <div className="t-mono ink-3">{row.accountId}</div>
                </td>
                <td className="ink-2">{row.role}</td>
                <td className={styles.num}>
                  <Money value={row.netSen} decimals={2} />
                </td>
                <td className={`${styles.num} ink-2`}>
                  <Money value={row.capSen} decimals={2} />
                </td>
                <td>
                  <StatusCell status={row.status} />
                  {row.missed ? (
                    <PayMissed accountId={row.accountId} connected={connected} />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {caption ? (
        <p className={`t-caption ink-3 ${styles.tableNote}`}>
          Names come from Homeroll's own records. The chain sees only the w- accounts.
        </p>
      ) : null}
    </div>
  );
}
