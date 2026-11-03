"use client";

import { CheckCircle, X } from "@phosphor-icons/react";
import { type RefObject, useTransition } from "react";
import { connect, disconnect } from "@/app/session-actions";
import { truncateMiddle } from "@/lib/format";
import type { DemoAccount, DemoAccountKey } from "@/lib/wallet/adapter";
import { available, unavailableReason } from "@/lib/wallet/near-connect";
import { Button } from "./Button";
import { PlaceholderRow } from "./PlaceholderRow";
import { Sheet } from "./Sheet";
import styles from "./WalletSheet.module.css";

export function WalletSheet({
  open,
  onClose,
  highlight,
  triggerRef,
  accounts,
  connected,
}: {
  open: boolean;
  onClose: () => void;
  highlight: DemoAccountKey | null;
  triggerRef: RefObject<HTMLElement | null>;
  accounts: DemoAccount[];
  connected: DemoAccount | null;
}) {
  const [pending, start] = useTransition();

  const pick = (key: DemoAccountKey) =>
    start(async () => {
      await connect(key);
      onClose();
    });

  return (
    <Sheet open={open} onClose={onClose} title="Connect wallet" triggerRef={triggerRef}>
      <div className={styles.sheet}>
        <div className={styles.header}>
          <span className="t-headline">{connected ? "Wallet" : "Connect wallet"}</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <p className="t-caption ink-2">
          Demo mode. The server holds these keys and signs for you. This browser never sees one.
        </p>
        <ul className={styles.list}>
          {accounts.map((a) => {
            const isConnected = connected?.key === a.key;
            return (
              <li key={a.key}>
                <button
                  type="button"
                  className={styles.row}
                  data-highlight={highlight === a.key || undefined}
                  disabled={pending}
                  onClick={() => pick(a.key)}
                  aria-pressed={isConnected}
                >
                  <span className={styles.who}>
                    <span className="t-headline">{a.name}</span>
                    <span className="t-caption ink-2">{a.role}</span>
                    <span className="t-mono ink-3">{truncateMiddle(a.accountId, 24, 8)}</span>
                  </span>
                  {isConnected ? (
                    <CheckCircle
                      size={20}
                      weight="fill"
                      className={styles.check}
                      aria-label="Connected"
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        {!available ? (
          <PlaceholderRow name="Your own NEAR wallet" caption={unavailableReason} />
        ) : null}
        {connected ? (
          <Button
            variant="plain"
            fullWidth
            disabled={pending}
            onClick={() =>
              start(async () => {
                await disconnect();
                onClose();
              })
            }
          >
            Disconnect
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}
