"use client";

import { CheckCircle, Wallet } from "@phosphor-icons/react";
import { useRef } from "react";
import { truncateMiddle } from "@/lib/format";
import type { DemoAccountKey } from "@/lib/wallet/adapter";
import { Button, type ButtonProps } from "./Button";
import styles from "./WalletButton.module.css";
import { useWallet } from "./WalletProvider";

/** Toolbar button: "Connect wallet", or the connected name and a middle-truncated account. */
export function WalletButton() {
  const { connected, open } = useWallet();
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span ref={ref} className={styles.wrap}>
      <Button
        variant="tinted"
        size="small"
        icon={connected ? <CheckCircle size={20} weight="regular" /> : <Wallet size={20} />}
        onClick={() => open(undefined, ref.current?.querySelector("button"))}
        aria-haspopup="dialog"
      >
        {connected ? (
          <span className={styles.label}>
            <span>{connected.shortName}</span>
            <span className={`${styles.account} t-mono`}>
              · {truncateMiddle(connected.accountId)}
            </span>
          </span>
        ) : (
          "Connect wallet"
        )}
      </Button>
    </span>
  );
}

/** A page's primary button in its "needs a wallet" state: opens the sheet with that account highlighted. */
export function ConnectButton({
  account,
  ...props
}: { account: DemoAccountKey } & Pick<ButtonProps, "fullWidth" | "variant" | "size">) {
  const { open } = useWallet();
  return (
    <Button
      {...props}
      icon={<Wallet size={20} />}
      onClick={(e) => open(account, e.currentTarget)}
      aria-haspopup="dialog"
    >
      Connect wallet
    </Button>
  );
}
