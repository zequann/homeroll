import { CheckCircle, Warning, XCircle } from "@phosphor-icons/react/ssr";
import { Badge } from "@/components/Badge";
import { ContractErrorNote } from "@/components/ContractErrorNote";
import { Money } from "@/components/Money";
import type { InvoiceAgentResult } from "@/lib/agents/invoice-agent";
import type { InvoiceRow } from "@/lib/views/owner";
import { BuyerPaid, CheckInvoice } from "./InvoiceActions";
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
      <ul className={styles.invoiceList}>
        {rows.map((inv) => (
          <li key={inv.number} className={styles.invoiceItem}>
            <div className={styles.invoice}>
              <div className={styles.invoiceMain}>
                <div className="t-headline">{inv.number}</div>
                <div className="ink-2">{inv.buyer}</div>
                <div className="ink-2">
                  <Money value={inv.amountSen} decimals={2} /> · due {inv.due}
                </div>
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
            <Money value={offer.advanceSen} decimals={2} />
          </dd>
          <dt>Fee</dt>
          <dd>
            <Money value={offer.feeSen} decimals={2} />
          </dd>
          <dt>Pool gets back</dt>
          <dd>
            <Money value={offer.poolGetsBackSen} decimals={2} />
          </dd>
          <dt>You get when the buyer pays</dt>
          <dd>
            <Money value={offer.ownerGetsSen} decimals={2} />
          </dd>
        </dl>
      ) : null}
      {row.status === "Advanced" && row.advanceSen !== null ? (
        <span className="ink-2">
          Advanced <Money value={row.advanceSen} decimals={2} /> · fee{" "}
          {row.feeSen !== null ? <Money value={row.feeSen} decimals={2} /> : null}
        </span>
      ) : null}
      {row.status === "Settled" && offer ? (
        <span className="ink-2">
          Buyer paid. Pool repaid <Money value={offer.poolGetsBackSen} decimals={2} />, you received{" "}
          <Money value={offer.ownerGetsSen} decimals={2} />.
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

const ICON = {
  ok: <CheckCircle size={18} weight="fill" className={styles.ok} aria-label="Passed" />,
  warn: <Warning size={18} weight="fill" className={styles.warn} aria-label="Warning" />,
  fail: <XCircle size={18} weight="fill" className={styles.bad} aria-label="Failed" />,
};

function AgentReport({ result }: { result: InvoiceAgentResult }) {
  const { model } = result;
  const said = [
    model.suggestedGrade ? `grade ${model.suggestedGrade}` : null,
    model.suggestedAdvancePercent !== null ? `${model.suggestedAdvancePercent}% advance` : null,
    ...model.flags,
  ].filter(Boolean);
  return (
    <div className={styles.report}>
      <ul className={styles.checks}>
        {result.checks.map((c) => (
          <li key={c.id} className={styles.check}>
            {ICON[c.result]}
            <div>
              <div>{c.title}</div>
              <div className="t-caption ink-3">{c.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      <div className={styles.modelSaid}>
        <div className={styles.gradeLine}>
          <span className="t-caption ink-3">What the model said</span>
          {model.mock ? <Badge>{model.label}</Badge> : null}
        </div>
        <p className="ink-2">
          {said.length ? said.join(" · ") : "Fields extracted. No grade suggested."}
        </p>
        {model.ignored ? <p className={`t-caption ${styles.warn}`}>{model.ignored}</p> : null}
        {model.droppedFields.length ? (
          <p className="t-caption ink-3">
            Dropped unknown fields: <span className="t-mono">{model.droppedFields.join(", ")}</span>
          </p>
        ) : null}
        <p className="t-caption ink-3">
          Grade from the rules: {result.ruleGrade}. Final: {result.grade}. The model can only lower
          a grade (R9).
        </p>
        {result.attest.ok ? (
          <p className="t-caption ink-3">
            Registered on the pool · <span className="t-mono">{result.attest.txHash}</span>
          </p>
        ) : (
          <ContractErrorNote
            sentence={result.attest.failure.sentence}
            code={result.attest.failure.code}
            ruleCaption={result.attest.failure.ruleCaption}
          />
        )}
      </div>
    </div>
  );
}
