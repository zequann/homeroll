"use client";

import { PaperPlaneTilt } from "@phosphor-icons/react";
import { useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { formatRm, formatTaka, parseRm, type Sen } from "@/lib/fx";
import { BENCHMARKS, benchmarkTaka, type RemitQuote, SampleQuote } from "@/lib/remit";
import { priceSwap, sendHome } from "../actions";
import styles from "./worker.module.css";

const pct = (bps: number) => `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;

export function SendHome({
  balanceSen,
  recipient,
  liveQuotes,
}: {
  balanceSen: Sen;
  recipient: { label: string; wallet: string; city: string };
  /** The server asks NEAR Intents for a dry-run quote as the amount changes. */
  liveQuotes: boolean;
}) {
  const [text, setText] = useState("800");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const amount = parseRm(text);
  const hasBalance = balanceSen > 0;
  const tooMuch = amount !== null && amount > balanceSen;
  const [live, setLive] = useState<RemitQuote | null>(null);
  const sample = amount !== null && amount > 0 ? SampleQuote.quote(amount) : null;
  const quote = live && live.amountSen === amount ? live : sample;
  const isLive = quote?.swap.source === "live";

  useEffect(() => {
    if (!liveQuotes || amount === null || amount <= 0) return;
    let stale = false;
    const id = setTimeout(async () => {
      const next = await priceSwap(amount).catch(() => null);
      if (!stale) setLive(next);
    }, 400);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [amount, liveQuotes]);

  const hint = !hasBalance
    ? "You have RM0.00. Your October wage arrives when Perabot Jaya runs payroll."
    : amount === null || amount === 0
      ? "Enter an amount in RM, like 800 or 800.50."
      : tooMuch
        ? `You have ${formatRm(balanceSen, { decimals: 2 })}.`
        : null;
  const canSend = quote !== null && !tooMuch && hasBalance;

  const rows = [
    { who: "Homeroll", bps: quote?.totalBps ?? 110, taka: quote?.takaOut ?? null, sample: true },
    ...BENCHMARKS.map((b) => ({
      who: b.label,
      bps: b.bps,
      taka: amount ? benchmarkTaka(amount, b.bps) : null,
      sample: false,
    })),
  ];

  return (
    <div className={styles.send}>
      <div className={styles.recipient}>
        <span className="t-headline">{recipient.label}</span>
        <span className="ink-2">
          {recipient.wallet} · {recipient.city}
        </span>
      </div>

      <div>
        <label className={styles.field}>
          <span className={styles.fieldPrefix}>RM</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            value={text}
            aria-describedby="send-hint"
            aria-invalid={hint !== null && hasBalance}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
          />
        </label>
        <p id="send-hint" className={`t-caption ${styles.hint}`} aria-live="polite">
          {hint ?? "\u00a0"}
        </p>
      </div>

      <p className={styles.receives}>
        {quote ? `Amma receives ${formatTaka(quote.takaOut)}` : "Amma receives ৳0"}
      </p>

      <ul className={styles.compare}>
        {rows.map((r) => (
          <li key={r.who} className={styles.compareRow} data-homeroll={r.sample || undefined}>
            <span className={styles.compareWho}>
              {r.who}
              {r.sample ? <Badge>{isLive ? "Live quote" : "Sample quote"}</Badge> : null}
            </span>
            <span className="ink-2">{pct(r.bps)}</span>
            <span className={styles.compareTaka}>{r.taka === null ? "–" : formatTaka(r.taka)}</span>
          </li>
        ))}
      </ul>
      <p className="t-caption ink-3">
        {isLive
          ? "Swap leg: NEAR Intents live quote, no funds moved."
          : "Swap leg is a made-up sample."}{" "}
        Payout fee 1.0% is an assumption. Averages: World Bank Remittance Prices Worldwide, Q3 2025,
        sending USD 200.
      </p>

      {error ? (
        <p className={`t-caption ${styles.error}`} role="alert">
          {error}
        </p>
      ) : null}

      <Button
        fullWidth
        icon={<PaperPlaneTilt size={20} />}
        disabled={!canSend}
        pending={pending}
        pendingLabel="Sending…"
        onClick={() =>
          amount &&
          start(async () => {
            const result = await sendHome(amount);
            if (result && !result.ok) {
              setError(
                result.reason === "too-much"
                  ? "That is more than your balance."
                  : `Not sent. ${result.message} Nothing left your account.`,
              );
            }
          })
        }
      >
        Send home
      </Button>
    </div>
  );
}
