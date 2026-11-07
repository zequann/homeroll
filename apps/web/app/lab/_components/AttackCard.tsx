"use client";

import { ShieldCheck } from "@phosphor-icons/react";
import { useState, useTransition } from "react";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { ContractErrorNote } from "@/components/ContractErrorNote";
import { Money } from "@/components/Money";
import type { AttackId } from "@/lib/attacks";
import { type AttackResult, runAttack } from "../actions";
import styles from "./lab.module.css";

export function AttackCard({
  id,
  title,
  story,
  badge,
  download,
}: {
  id: AttackId;
  title: string;
  /** The attacker's input, quoted. */
  story: string;
  /** What this attack's agent runs on, when it is mocked ("Mock model"). */
  badge?: string;
  /** A document this attack uses. */
  download?: { href: string; label: string };
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<AttackResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <article className={styles.card} aria-labelledby={`attack-${id}`}>
      <div className={styles.cardHead}>
        <h2 id={`attack-${id}`} className="t-headline">
          {id} {title} {badge ? <Badge>{badge}</Badge> : null}
        </h2>
        <Button
          variant="plain"
          size="small"
          pending={pending}
          pendingLabel="Running…"
          onClick={() =>
            start(async () => {
              setError(null);
              try {
                setResult(await runAttack(id));
              } catch {
                setError("The attack could not run. Press Reset demo, then try again.");
              }
            })
          }
        >
          Run attack
        </Button>
      </div>
      <blockquote className={styles.story}>{story}</blockquote>
      {download ? (
        <a className="t-caption" href={download.href}>
          {download.label}
        </a>
      ) : null}

      {error ? (
        <p className="t-caption" role="alert">
          {error}
        </p>
      ) : null}

      {result ? (
        <dl className={styles.result}>
          <dt className="t-caption ink-3">Agent proposed</dt>
          <dd>{result.proposed}</dd>

          <dt className="t-caption ink-3">
            {result.stoppedBy} said no
            {result.simulated ? (
              <>
                {" "}
                <Badge>Simulated on fake chain</Badge>
              </>
            ) : null}
          </dt>
          <dd className={styles.failures}>
            {result.failures.map((f) => (
              <ContractErrorNote
                key={f.code + f.sentence}
                sentence={f.sentence}
                code={f.code}
                ruleCaption={f.ruleCaption}
              />
            ))}
          </dd>

          {result.notes.length ? (
            <>
              <dt className="t-caption ink-3">Notes</dt>
              <dd>
                <ul className={styles.notes}>
                  {result.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}

          <dt className="t-caption ink-3">{result.money.label} before · after</dt>
          <dd className={styles.treasury}>
            <Money value={result.money.beforeSen} /> · <Money value={result.money.afterSen} />
            {result.money.beforeSen === result.money.afterSen ? (
              <span className={styles.safe}>
                <ShieldCheck size={14} weight="fill" aria-hidden />
                No money moved.
              </span>
            ) : null}
          </dd>
        </dl>
      ) : null}
    </article>
  );
}
