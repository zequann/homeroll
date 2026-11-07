"use client";

import { ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { ConnectButton } from "@/components/WalletButton";
import {
  type DepositQuoteView,
  type DepositResult,
  depositPrivately,
  priceLenderDeposit,
} from "../actions";
import styles from "../lender.module.css";

export interface AssetOption {
  key: string;
  label: string;
  symbol: string;
  decimals: number;
}

const AMOUNT = /^\d[\d,]*(\.\d*)?$/;

function txLink(network: "fake" | "testnet", hash: string) {
  if (network !== "testnet") return <span className="t-mono">{hash}</span>;
  return (
    <a
      className="t-mono"
      href={`https://testnet.nearblocks.io/txns/${hash}`}
      target="_blank"
      rel="noreferrer"
    >
      {hash.slice(0, 10)}…
    </a>
  );
}

/** Private deposit from any chain (SPEC §8.9): live or sample price, mock routing and delivery. */
export function PrivateDeposit({
  assets,
  connected,
  network,
}: {
  assets: AssetOption[];
  connected: boolean;
  network: "fake" | "testnet";
}) {
  const [assetKey, setAssetKey] = useState(assets[0]?.key ?? "");
  const [text, setText] = useState("1000");
  const [quote, setQuote] = useState<DepositQuoteView | null>(null);
  const [result, setResult] = useState<DepositResult | null>(null);
  const [pending, start] = useTransition();

  const asset = assets.find((a) => a.key === assetKey);
  // Shape only, and not zero. The server parses the amount exactly, in base units.
  const valid = AMOUNT.test(text.trim()) && /[1-9]/.test(text);
  const current = quote && quote.assetKey === assetKey && quote.amount === text ? quote : null;

  useEffect(() => {
    if (!valid) return;
    let stale = false;
    const id = setTimeout(async () => {
      const next = await priceLenderDeposit({ assetKey, amount: text }).catch(() => null);
      if (!stale) setQuote(next);
    }, 400);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [assetKey, text, valid]);

  const swapStep = !current
    ? { badge: null, caption: valid ? "Getting a price…" : "Enter an amount to see a price." }
    : current.source === "live"
      ? {
          badge: "Live quote",
          caption: current.confidential
            ? "Confidential dry run. No funds moved."
            : "Dry run. No funds moved.",
        }
      : { badge: "Sample quote", caption: "Made-up price, not a quote." };
  const steps = [
    { label: "Swap · NEAR Intents", ...swapStep },
    {
      label: "Confidential routing · Confidential Intents",
      badge: "Mock routing",
      caption:
        "In production your wallet pays into a Confidential Intents account, so nobody can link it to your pool shares. It runs on mainnet only.",
    },
    {
      label: "Delivered as tUSDC on testnet",
      badge: "Mock delivery",
      caption:
        "A mock solver sends tUSDC to your account. Your account deposits it in the pool for real.",
    },
  ];

  return (
    <div className={styles.deposit}>
      <div className={styles.inputs}>
        <label className={styles.field}>
          <span className="t-caption ink-3">From</span>
          <select
            value={assetKey}
            onChange={(e) => {
              setAssetKey(e.target.value);
              setResult(null);
            }}
          >
            {assets.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className="t-caption ink-3">{asset?.symbol ?? ""}</span>
          <input
            inputMode="decimal"
            autoComplete="off"
            value={text}
            aria-invalid={!valid}
            aria-describedby="deposit-hint"
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
          />
        </label>
      </div>
      <p id="deposit-hint" className="t-caption ink-2" aria-live="polite">
        {valid ? " " : "Enter an amount, like 1,000 or 0.5."}
      </p>

      <p className={styles.receives}>
        {valid && current ? `≈ ${current.amountOut} into the pool` : "≈ – into the pool"}
      </p>

      <ol className={styles.steps}>
        {steps.map((s) => (
          <li key={s.label} className={styles.step}>
            <span className={styles.stepHead}>
              {s.label}
              {s.badge ? <Badge>{s.badge}</Badge> : null}
            </span>
            <span className="t-caption ink-3">{s.caption}</span>
          </li>
        ))}
      </ol>

      {result?.ok === false ? (
        <p className={`t-caption ${styles.error}`} role="alert">
          {result.message}
        </p>
      ) : null}
      {result?.ok ? (
        <div className={styles.receipt} role="status">
          <p className="t-headline">Deposited {result.amountOut}.</p>
          <p className="ink-2">
            On-chain this is <span className="t-mono">{result.lender}</span>. Your name is not
            on-chain.
          </p>
          <p className="t-caption ink-3">
            Mock delivery {txLink(network, result.deliveryTxHash)} · Pool deposit{" "}
            {txLink(network, result.depositTxHash)}
          </p>
        </div>
      ) : null}

      {connected ? (
        <Button
          fullWidth
          icon={<ShieldCheck size={20} />}
          disabled={!valid || !current}
          pending={pending}
          pendingLabel="Depositing…"
          onClick={() =>
            start(async () => {
              setResult(await depositPrivately({ assetKey, amount: text }));
            })
          }
        >
          Deposit privately
        </Button>
      ) : (
        <ConnectButton account="lender" fullWidth />
      )}
    </div>
  );
}
