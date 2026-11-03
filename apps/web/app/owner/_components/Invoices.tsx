import { Badge } from "@/components/Badge";
import { Money } from "@/components/Money";
import { PlaceholderRow } from "@/components/PlaceholderRow";
import type { InvoiceRow } from "@/lib/views/owner";
import styles from "./owner.module.css";
import { TakeAdvance } from "./TakeAdvance";

export function Invoices({ rows, connected }: { rows: InvoiceRow[]; connected: boolean }) {
  return (
    <div>
      <ul className={styles.invoiceList}>
        {rows.map((inv) => (
          <li key={inv.number} className={styles.invoice}>
            <div className={styles.invoiceMain}>
              <div className="t-headline">{inv.number}</div>
              <div className="ink-2">{inv.buyer}</div>
              <div className="ink-2">
                <Money value={inv.amountSen} />
              </div>
            </div>
            <div className={styles.invoiceGrade}>
              <div className={styles.gradeLine}>
                <span className="t-headline">Grade {inv.grade}</span>
                <Badge>Mock model</Badge>
              </div>
              <span className="t-caption ink-3">Graded by the invoice agent</span>
              <span className="ink-2">
                {inv.declinedReason ??
                  (inv.status === "Advanced" ? (
                    <>
                      Advanced · <Money value={inv.advanceSen} /> · fee <Money value={inv.feeSen} />
                    </>
                  ) : (
                    <>
                      Advance <Money value={inv.advanceSen} /> · fee <Money value={inv.feeSen} />
                    </>
                  ))}
              </span>
            </div>
            <div className={styles.invoiceAction}>
              {inv.status === "Advanced" ? (
                <span className={styles.ok}>Advanced</span>
              ) : inv.status === "Attested" ? (
                <TakeAdvance number={inv.number} connected={connected} />
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <PlaceholderRow name="Check a new invoice" caption="Not in this build (SPEC §8.1)." />
    </div>
  );
}
