"use client";

import { ShieldCheck } from "@phosphor-icons/react";
import { useState, useTransition } from "react";
import { Button } from "@/components/Button";
import { ContractErrorNote } from "@/components/ContractErrorNote";
import { Money } from "@/components/Money";
import { type AttackResult, runAttack } from "../actions";
import styles from "./lab.module.css";

export function AttackCard({
  id,
  title,
  story,
}: {
  id: "02" | "01";
  title: string;
  /** The attacker's input, quoted. */
  story: string;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<AttackResult | null>(null);

  return (
    <article className={styles.card} aria-labelledby={`attack-${id}`}>
      <div className={styles.cardHead}>
        <h2 id={`attack-${id}`} className="t-headline">
          {id} {title}
        </h2>
        <Button
          variant="plain"
          size="small"
          pending={pending}
          pendingLabel="Running…"
          onClick={() =>
            start(async () => {
              setResult(await runAttack(id));
            })
          }
        >
          Run attack
        </Button>
      </div>
      <blockquote className={styles.story}>{story}</blockquote>

      {result ? (
        <dl className={styles.result}>
          <dt className="t-caption ink-3">Agent proposed</dt>
          <dd>{result.proposed}</dd>

          <dt className="t-caption ink-3">Payroll contract said no</dt>
          <dd>
            <ContractErrorNote
              sentence={result.failure.sentence}
              code={result.failure.code}
              ruleCaption={result.failure.ruleCaption}
            />
          </dd>

          <dt className="t-caption ink-3">Treasury before · after</dt>
          <dd className={styles.treasury}>
            <Money value={result.treasuryBefore} /> · <Money value={result.treasuryAfter} />
            <span className={styles.safe}>
              <ShieldCheck size={14} weight="fill" aria-hidden />
              Nothing was reserved or paid.
            </span>
          </dd>
        </dl>
      ) : null}
    </article>
  );
}
