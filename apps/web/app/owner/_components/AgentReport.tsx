import { CheckCircle, Warning, XCircle } from "@phosphor-icons/react/ssr";
import { Badge } from "@/components/Badge";
import { ContractErrorNote } from "@/components/ContractErrorNote";
import type { InvoiceAgentResult } from "@/lib/agents/invoice-agent";
import styles from "./owner.module.css";

const ICON = {
  ok: <CheckCircle size={18} weight="fill" className={styles.ok} aria-label="Passed" />,
  warn: <Warning size={18} weight="fill" className={styles.warn} aria-label="Warning" />,
  fail: <XCircle size={18} weight="fill" className={styles.bad} aria-label="Failed" />,
};

/** The four checks, what the model said, and what the pool answered (SPEC §8.1). */
export function AgentReport({ result }: { result: InvoiceAgentResult }) {
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
        {result.attest.ok ? (
          <p className="t-caption ink-3">
            Grade from the rules: {result.ruleGrade}. Final: {result.grade}. The model can only
            lower a grade (R9).
          </p>
        ) : null}
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
