"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DemoAccount, DemoAccountKey } from "@/lib/wallet/adapter";
import { WalletSheet } from "./WalletSheet";

interface WalletContextValue {
  accounts: DemoAccount[];
  connected: DemoAccount | null;
  /** Opens the sheet. `highlight` marks the account a page's primary button needs. */
  open: (highlight?: DemoAccountKey, trigger?: HTMLElement | null) => void;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet needs <WalletProvider>");
  return value;
}

/** Hosts the wallet sheet for the whole app. Holds no key: the cookie only picks a demo account. */
export function WalletProvider({
  accounts,
  connected,
  children,
}: {
  accounts: DemoAccount[];
  connected: DemoAccount | null;
  children: ReactNode;
}) {
  const [isOpen, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<DemoAccountKey | null>(null);
  const trigger = useRef<HTMLElement | null>(null);

  const open = useCallback((key?: DemoAccountKey, from?: HTMLElement | null) => {
    setHighlight(key ?? null);
    trigger.current = from ?? (document.activeElement as HTMLElement | null);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  const value = useMemo(() => ({ accounts, connected, open }), [accounts, connected, open]);

  return (
    <WalletContext.Provider value={value}>
      {children}
      <WalletSheet
        open={isOpen}
        onClose={close}
        highlight={highlight}
        triggerRef={trigger}
        accounts={accounts}
        connected={connected}
      />
    </WalletContext.Provider>
  );
}
