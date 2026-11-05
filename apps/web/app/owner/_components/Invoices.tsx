import { Money } from "@/components/Money";
import type { InvoiceRow } from "@/lib/views/owner";
import { AgentReport } from "./AgentReport";
import { BuyerPaid, CheckInvoice } from "./InvoiceActions";
import { InvoiceUpload } from "./InvoiceUpload";
import styles from "./owner.module.css";
import { TakeAdvance } from "./TakeAdvance";

const pct = (bps: number) => `${bps / 100}%`;

export function Invoices({ rows, connected }: { rows: InvoiceRow[]; connected: boolean }) {
  return (
    <div>
      <p className={`t-caption ink-3 ${styles.tableNote}`}>
        The invoice agent reads each document with a mock model, checks it in code and registers it
        on the pool. The pool decides the advance.
      </p>
      <InvoiceUpload connected={connected} />
      <ul className={styles.invoiceList}>
        {rows.map((inv) => (
          <li key={inv.number} className={styles.invoiceItem}>
            <div className={styles.invoice}>
              <div className={styles.invoiceMain}>
                <div className="t-headline">{inv.number}</div>
                <div className="ink-2">{inv.buyer}</div>
                <div className="ink-2">
                  <Money value={inv.amountSen} /> · due {inv.due}
                </div>
                <a className="t-caption" href={`/api/invoices/${inv.number}`}>
                  Download PDF
                </a>
              </div>
              <div className={styles.invoiceGrade}>
                <Summary row={inv} />
              </div>
              <div className={styles.invoiceAction}>
                <Action row={inv} connected={connected} />
              </div>
            </div>
            {inv.agent ? <AgentReport result={inv.agent} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Summary({ row }: { row: InvoiceRow }) {
  if (row.status === "Unchecked") {
    return <span className="ink-3">Not checked yet</span>;
  }
  if (row.status === "Declined") {
    return (
      <>
        <span className="t-headline">Grade D · declined</span>
        <span className="ink-2">No advance. See the failed checks below.</span>
      </>
    );
  }
  const offer = row.offer;
  return (
    <>
      <div className={styles.gradeLine}>
        <span className="t-headline">Grade {row.grade}</span>
        {offer ? (
          <span className="ink-2">
            {pct(offer.advanceBps)} advance, {pct(offer.feeBps)} fee
          </span>
        ) : null}
      </div>
      {row.status === "Attested" && offer ? (
        <dl className={styles.offer}>
          <dt>Advance now</dt>
          <dd>
            <Money value={offer.advanceSen} />
          </dd>
          <dt>Fee</dt>
          <dd>
            <Money value={offer.feeSen} />
          </dd>
          <dt>Pool gets back</dt>
          <dd>
            <Money value={offer.poolGetsBackSen} />
          </dd>
          <dt>You get when the buyer pays</dt>
          <dd>
            <Money value={offer.ownerGetsSen} />
          </dd>
        </dl>
      ) : null}
      {row.status === "Advanced" && row.advanceSen !== null ? (
        <span className="ink-2">
          Advanced <Money value={row.advanceSen} /> · fee{" "}
          {row.feeSen !== null ? <Money value={row.feeSen} /> : null}
        </span>
      ) : null}
      {row.status === "Settled" && offer ? (
        <span className="ink-2">
          Buyer paid. Pool repaid <Money value={offer.poolGetsBackSen} />, you received{" "}
          <Money value={offer.ownerGetsSen} />.
        </span>
      ) : null}
    </>
  );
}

function Action({ row, connected }: { row: InvoiceRow; connected: boolean }) {
  switch (row.status) {
    case "Unchecked":
      return <CheckInvoice number={row.number} connected={connected} />;
    case "Attested":
      return <TakeAdvance number={row.number} connected={connected} />;
    case "Advanced":
      return <BuyerPaid number={row.number} connected={connected} />;
    case "Settled":
      return <span className={styles.ok}>Settled</span>;
    case "Declined":
      return <span className={styles.bad}>Declined</span>;
  }
}
