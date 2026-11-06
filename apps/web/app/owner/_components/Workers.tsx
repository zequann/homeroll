"use client";

import { useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { ContractErrorNote } from "@/components/ContractErrorNote";
import { Money } from "@/components/Money";
import { ConnectButton } from "@/components/WalletButton";
import type { FailureView } from "@/lib/describe-failure";
import type { PayeeRow } from "@/lib/views/owner";
import { addPayee, addPayeeBack, type OwnerCallResult, removePayee } from "../actions";
import styles from "./owner.module.css";

/** "47 h 59 min left", refreshed each minute. The contract decides; this only reads activeFrom. */
function HoldCountdown({ activeFromMs }: { activeFromMs: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return <span>On hold</span>;
  const minutes = Math.max(0, Math.ceil((activeFromMs - now) / 60_000));
  return (
    <span>
      On hold · {Math.floor(minutes / 60)} h {minutes % 60} min left
    </span>
  );
}

export function Workers({
  rows,
  connected,
  onboarding,
}: {
  rows: PayeeRow[];
  connected: boolean;
  onboarding: boolean;
}) {
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<FailureView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", role: "", cap: "" });
  const payeeCount = rows.filter((r) => r.status !== "Removed").length;

  const show = (result: OwnerCallResult) => {
    if (!result.ok && result.reason === "rejected") setFailure(result.failure);
  };
  const run = (call: () => Promise<OwnerCallResult>) =>
    start(async () => {
      setFailure(null);
      setMessage(null);
      show(await call());
    });

  return (
    <div className={styles.workers}>
      {connected ? (
        <form
          className={styles.payeeForm}
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              setFailure(null);
              setMessage(null);
              const result = await addPayee(form);
              if (result.ok) setForm({ name: "", role: "", cap: "" });
              else if (result.reason === "invalid") setMessage(result.message);
              else if (result.reason === "rejected") setFailure(result.failure);
            });
          }}
        >
          <label>
            <span className="t-caption ink-3">Made-up name</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label>
            <span className="t-caption ink-3">Role</span>
            <input
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              autoComplete="off"
            />
          </label>
          <label>
            <span className="t-caption ink-3">Wage cap (RM)</span>
            <input
              value={form.cap}
              inputMode="decimal"
              onChange={(e) => setForm({ ...form, cap: e.target.value })}
              autoComplete="off"
            />
          </label>
          <Button type="submit" variant="tinted" pending={pending} pendingLabel="Adding…">
            Add payee
          </Button>
        </form>
      ) : (
        <ConnectButton account="owner" variant="tinted" size="small" />
      )}

      <p className={`t-caption ink-3 ${styles.tableNote}`}>
        {payeeCount} of 40 payees.{" "}
        {onboarding
          ? "During onboarding a new payee is active at once. After the first run, a new payee waits 48 hours."
          : "A new payee waits 48 hours before they can be paid."}{" "}
        The server picks a random account. The name stays in Homeroll's records.
      </p>
      {message ? (
        <p className={`t-caption ${styles.bad}`} role="alert">
          {message}
        </p>
      ) : null}
      {failure ? (
        <ContractErrorNote
          sentence={failure.sentence}
          code={failure.code}
          ruleCaption={failure.ruleCaption}
        />
      ) : null}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Worker</th>
              <th scope="col">Role</th>
              <th scope="col" className={styles.num}>
                Wage cap
              </th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
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
                <td className={`${styles.num} ink-2`}>
                  <Money value={row.capSen} decimals={2} />
                </td>
                <td>
                  {row.status === "On hold" && row.activeFromMs !== null ? (
                    <Badge>48-hour hold</Badge>
                  ) : (
                    <span className={row.status === "Active" ? styles.ok : "ink-3"}>
                      {row.status}
                    </span>
                  )}
                  {row.status === "On hold" && row.activeFromMs !== null ? (
                    <div className="t-caption ink-3">
                      <HoldCountdown activeFromMs={row.activeFromMs} />
                    </div>
                  ) : null}
                </td>
                <td className={styles.num}>
                  {connected ? (
                    row.status === "Removed" ? (
                      <Button
                        variant="plain"
                        size="small"
                        disabled={pending}
                        onClick={() => run(() => addPayeeBack(row.accountId))}
                      >
                        Add back
                      </Button>
                    ) : (
                      <Button
                        variant="plain"
                        size="small"
                        disabled={pending}
                        onClick={() => run(() => removePayee(row.accountId))}
                      >
                        Remove
                      </Button>
                    )
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
