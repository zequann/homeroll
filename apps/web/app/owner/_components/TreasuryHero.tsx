"use client";

import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/Button";
import { ContractErrorNote } from "@/components/ContractErrorNote";
import { Money } from "@/components/Money";
import { RollingMoney } from "@/components/RollingMoney";
import { ConnectButton } from "@/components/WalletButton";
import { formatRm, type Sen } from "@/lib/fx";
import {
  approvePayout,
  cancelPayroll,
  fundTreasury,
  payNextBatch,
  submitPayroll,
} from "../actions";
import styles from "./owner.module.css";
import {
  buttonEnabled,
  buttonLabel,
  deriveRunState,
  IDLE,
  type LocalPhase,
  type RunFacts,
  type RunState,
} from "./run-state";

export interface TreasuryHeroProps {
  companyName: string;
  treasurySen: Sen;
  treasuryUsdc: string;
  bufferSen: Sen;
  periodLabel: string;
  facts: RunFacts;
  /** The owner demo account is connected, so the page can sign. */
  connected: boolean;
  /** Testnet only. Mints tUSDC into this company's treasury. */
  canFund: boolean;
}

export function TreasuryHero(props: TreasuryHeroProps) {
  const {
    companyName,
    treasurySen,
    treasuryUsdc,
    bufferSen,
    periodLabel,
    facts,
    connected,
    canFund,
  } = props;
  const [fundNote, setFundNote] = useState<string | null>(null);
  const router = useRouter();
  const [local, setLocal] = useState<LocalPhase>(IDLE);
  const [pending, start] = useTransition();
  const state = deriveRunState(facts, local);

  /** The owner's payout intent first (SPEC §8.11). The sealed approval, or null when refused. */
  async function approve(runId: number): Promise<string | null> {
    setLocal({ checking: false, approving: true, rejection: null, paying: null });
    const approved = await approvePayout(runId);
    if (approved.ok) return approved.approval;
    const failure =
      approved.reason === "rejected"
        ? approved.failure
        : {
            sentence: "Connect the owner wallet to pay.",
            code: "NOT_CONNECTED",
            ruleCaption: null,
          };
    setLocal({ ...IDLE, rejection: { failure, atTreasury: treasurySen } });
    return null;
  }

  async function payAll(runId: number, total: number, from: number) {
    const approval = await approve(runId);
    if (!approval) return;
    setLocal({ checking: false, rejection: null, paying: { paid: from, total, runId } });
    for (;;) {
      const batch = await payNextBatch(runId, approval);
      if (!batch.ok) {
        const failure =
          batch.reason === "rejected"
            ? batch.failure
            : {
                sentence: "Connect the owner wallet to pay.",
                code: "NOT_CONNECTED",
                ruleCaption: null,
              };
        setLocal({ ...IDLE, rejection: { failure, atTreasury: treasurySen } });
        return;
      }
      setLocal({
        checking: false,
        rejection: null,
        paying: { paid: batch.paid, total: batch.total, runId },
      });
      if (batch.done) break;
    }
    setLocal(IDLE);
  }

  const run = () => {
    // The label answers on this frame, before any network call.
    if (state.kind === "paying" && !state.inFlight) {
      const { runId, paid, total } = state;
      setLocal({ checking: false, rejection: null, paying: { paid, total, runId } });
      start(() => payAll(runId, total, paid));
      return;
    }
    setLocal({ checking: true, paying: null, rejection: null });
    start(async () => {
      const submitted = await submitPayroll();
      if (!submitted.ok) {
        if (submitted.reason === "not-connected") {
          setLocal(IDLE);
          return;
        }
        setLocal({
          ...IDLE,
          rejection: {
            failure: submitted.failure,
            shortfall: submitted.failure.shortfallSen ?? undefined,
            atTreasury: treasurySen,
          },
        });
        return;
      }
      await payAll(submitted.runId, submitted.lineCount, 0);
    });
  };

  /** Reserves the run without paying, so the owner can still cancel it or change the payee list. */
  const reserveOnly = () => {
    setLocal({ checking: true, paying: null, rejection: null });
    start(async () => {
      const submitted = await submitPayroll();
      setLocal(
        submitted.ok || submitted.reason === "not-connected"
          ? IDLE
          : {
              ...IDLE,
              rejection: {
                failure: submitted.failure,
                shortfall: submitted.failure.shortfallSen ?? undefined,
                atTreasury: treasurySen,
              },
            },
      );
    });
  };

  const cancel = (runId: number) =>
    start(async () => {
      const result = await cancelPayroll(runId);
      setLocal(
        result.ok || result.reason === "not-connected"
          ? IDLE
          : { ...IDLE, rejection: { failure: result.failure, atTreasury: treasurySen } },
      );
    });

  const canAct = state.kind !== "done" && state.kind !== "nothingToRun";
  const canReserve = connected && state.kind === "ready" && !pending;

  return (
    <div className={styles.hero}>
      <div className={styles.heroCol}>
        <p className="t-caption ink-3">Treasury · {companyName}</p>
        <div className={`t-display ${styles.treasury}`}>
          <RollingMoney value={treasurySen} />
        </div>
        <p className="t-caption ink-3">
          {treasuryUsdc} · keeps a {formatRm(bufferSen)} buffer
        </p>

        <StatusLine state={state} facts={facts} bufferSen={bufferSen} />

        <div className={styles.heroActions}>
          {canAct && !connected ? (
            <ConnectButton account="owner" />
          ) : (
            <Button variant="primary" disabled={!buttonEnabled(state, pending)} onClick={run}>
              {buttonLabel(state)}
            </Button>
          )}
          {canReserve ? (
            <Button variant="plain" onClick={reserveOnly}>
              Reserve only
            </Button>
          ) : null}
          {state.kind === "paying" && !state.inFlight && connected ? (
            <Button variant="plain" disabled={pending} onClick={() => cancel(state.runId)}>
              Cancel run
            </Button>
          ) : null}
          {state.kind === "short" && connected ? (
            <Button
              variant="tinted"
              onClick={() => router.replace("/owner?tab=invoices", { scroll: false })}
            >
              Take advance
            </Button>
          ) : null}
          {canFund && connected ? (
            <Button
              variant="tinted"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setFundNote(null);
                  const result = await fundTreasury();
                  if (result.ok) setFundNote("Added RM20,000 of testnet tUSDC.");
                  else if (result.reason === "rejected") setFundNote(result.failure.sentence);
                  else setFundNote("Connect the owner first.");
                  router.refresh();
                })
              }
            >
              Add RM20,000
            </Button>
          ) : null}
          {fundNote ? <span className="t-caption ink-3">{fundNote}</span> : null}
          <span className="t-caption ink-3">
            {periodLabel} · {facts.lineCount} workers ·{" "}
            <Money value={facts.periodTotalSen ?? facts.totalSen} />
          </span>
        </div>
      </div>
    </div>
  );
}

function StatusLine({
  state,
  facts,
  bufferSen,
}: {
  state: RunState;
  facts: RunFacts;
  bufferSen: Sen;
}) {
  let body: React.ReactNode = null;
  switch (state.kind) {
    case "ready":
      body = <p>{formatRm(state.leftAfter)} left after this run.</p>;
      break;
    case "short":
      body = (
        <p className={styles.warn}>
          <WarningCircle size={20} weight="regular" />
          <span>
            Short by {formatRm(state.shortfall)}. October payroll needs{" "}
            {formatRm((facts.totalSen + bufferSen) as Sen)}, including the {formatRm(bufferSen)}{" "}
            buffer.
          </span>
        </p>
      );
      break;
    case "checking":
      body = <p>The payroll contract is checking all {facts.lineCount} pay lines.</p>;
      break;
    case "approving":
      body = (
        <p>The owner signs the payout intent. The payout rail checks it before anything is paid.</p>
      );
      break;
    case "paying":
      body = (
        <p>
          {!state.inFlight && state.paid === 0
            ? `${state.total} pay lines reserved. Nothing is paid yet.`
            : `Paid ${state.paid} of ${state.total}${state.inFlight ? "" : ". This run was left half paid."}`}
        </p>
      );
      break;
    case "done":
      body = (
        <p className={styles.ok}>
          <CheckCircle size={20} weight="regular" />
          <span>
            October paid · {state.lineCount} workers · {formatRm(state.total)}
            {state.missed ? ` · ${state.missed} not paid` : ""}
          </span>
        </p>
      );
      break;
    case "rejected":
      body = (
        <ContractErrorNote
          sentence={state.failure.sentence}
          code={state.failure.code}
          ruleCaption={state.failure.ruleCaption}
        />
      );
      break;
    case "nothingToRun":
      body = <p>Every worker already has October pay.</p>;
      break;
  }
  return (
    <div className={styles.status} aria-live="polite">
      {body}
    </div>
  );
}
