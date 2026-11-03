import { XCircle } from "@phosphor-icons/react/ssr";
import styles from "./ContractErrorNote.module.css";

/** A contract's no: the plain sentence first, the exact code under it, the rule at the end. */
export function ContractErrorNote({
  sentence,
  code,
  ruleCaption,
}: {
  sentence: string;
  code: string;
  ruleCaption?: string | null;
}) {
  return (
    <div className={styles.note} role="alert">
      <XCircle size={20} weight="regular" className={styles.icon} aria-hidden />
      <div className={styles.body}>
        <p className={styles.sentence}>{sentence}</p>
        <p className="t-mono">{code}</p>
        {ruleCaption ? <p className="t-caption">{ruleCaption}</p> : null}
      </div>
    </div>
  );
}
