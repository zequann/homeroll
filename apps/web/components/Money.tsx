import { formatRmDigits, type Sen } from "@/lib/fx";
import styles from "./Money.module.css";

export interface MoneyProps {
  value: Sen;
  /** Omit for whole RM when there are no sen. 2 on the worker screen. */
  decimals?: 0 | 2;
  /** The RM prefix hangs outside the digits, so a centred amount centres its digits. */
  hang?: boolean;
}

export function Money({ value, decimals, hang }: MoneyProps) {
  const places = decimals ?? (value % 100 === 0 ? 0 : 2);
  return (
    <span className={styles.money}>
      <span className={hang ? styles.hung : styles.prefix}>RM</span>
      <span>{formatRmDigits(value, places)}</span>
    </span>
  );
}
