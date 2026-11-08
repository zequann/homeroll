"use client";

import { Bank } from "@phosphor-icons/react";
import { useState } from "react";
import { ActionFailed } from "@/components/ActionFailed";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { useActionTransition } from "@/components/useActionTransition";
import { CASHOUT_DESTINATIONS, type CashoutDestination, cashoutQuote } from "@/lib/cashout";
import { formatRm, parseRm, type Sen } from "@/lib/fx";
import { cashOut } from "../actions";
import styles from "./worker.module.css";

export function CashOut({ balanceSen }: { balanceSen: Sen }) {
  const [text, setText] = useState("200");
  const [destination, setDestination] = useState<CashoutDestination>("tng");
  const [pending, start, failed] = useActionTransition();
  const [error, setError] = useState<string | null>(null);

  const amount = parseRm(text);
  const tooMuch = amount !== null && amount > balanceSen;
  const quote = amount !== null && amount > 0 ? cashoutQuote(amount) : null;
  const hint =
    balanceSen === 0
      ? "You have RM0.00. Your wage arrives when your employer runs payroll."
      : amount === null || amount === 0
        ? "Enter an amount in RM, like 200 or 200.50."
        : tooMuch
          ? `You have ${formatRm(balanceSen, { decimals: 2 })}.`
          : null;

  return (
    <div className={styles.send}>
      <fieldset className={styles.choices}>
        <legend className="t-caption ink-3">To</legend>
        {CASHOUT_DESTINATIONS.map((d) => (
          <label
            key={d.key}
            className={styles.choice}
            data-active={d.key === destination || undefined}
          >
            <input
              type="radio"
              name="destination"
              value={d.key}
              checked={d.key === destination}
              onChange={() => setDestination(d.key)}
            />
            <span className="t-headline">{d.label}</span>
            <span className="ink-2">{d.masked}</span>
          </label>
        ))}
      </fieldset>

      <div>
        <label className={styles.field}>
          <span className={styles.fieldPrefix}>RM</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            value={text}
            aria-describedby="cashout-hint"
            aria-invalid={hint !== null && balanceSen > 0}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
        </label>
        <p id="cashout-hint" className={`t-caption ${styles.hint}`} aria-live="polite">
          {hint ?? " "}
        </p>
      </div>

      <div className={styles.leg}>
        <div className={styles.legTop}>
          <span className="t-headline">
            You receive {quote ? formatRm(quote.rmOutSen, { decimals: 2 }) : "RM0.00"}
          </span>
          <Badge>Mock partner</Badge>
        </div>
        <span className="t-caption ink-3">
          DuitNow off-ramp fee {quote ? formatRm(quote.feeSen, { decimals: 2 }) : "RM0.00"} (0.5%,
          an assumption). Network fees: RM0.00.
        </span>
      </div>

      {error ? (
        <p className={`t-caption ${styles.error}`} role="alert">
          {error}
        </p>
      ) : null}

      <Button
        fullWidth
        icon={<Bank size={20} />}
        disabled={quote === null || tooMuch || balanceSen === 0}
        pending={pending}
        pendingLabel="Cashing out…"
        onClick={() =>
          amount &&
          start(async () => {
            const result = await cashOut(amount, destination);
            if (result && !result.ok) {
              setError(
                result.reason === "too-much"
                  ? "That is more than your balance."
                  : result.reason === "relayer"
                    ? `Not sent. ${result.message} Nothing left your account.`
                    : "Connect Rahim's wallet to cash out.",
              );
            }
          })
        }
      >
        Cash out
      </Button>
      <ActionFailed show={failed} />
    </div>
  );
}
