import { Badge } from "@/components/Badge";
import type { KeyRow } from "@/lib/views/owner";
import styles from "./owner.module.css";

/** The "why NEAR" slide: what each key can do, and what it cannot, read through ChainClient.getAccessKeys. */
export function AgentKeys({ keys, mode }: { keys: KeyRow[]; mode: "fake" | "testnet" }) {
  return (
    <div className={styles.keys}>
      {mode === "fake" ? <Badge>Fake chain</Badge> : null}
      <ul className={styles.keyList}>
        {keys.map((k) => (
          <li key={`${k.accountId}:${k.title}`} className={styles.key}>
            <div className="t-headline">
              {k.title}
              <span className={`t-caption ink-3 ${styles.keyKind}`}>
                {k.kind === "FullAccess" ? "Full access" : "Function-call key"}
              </span>
            </div>
            <dl className={styles.keyFields}>
              <dt className="ink-3">On account</dt>
              <dd className="t-mono">{k.accountId}</dd>
              {k.receiver ? (
                <>
                  <dt className="ink-3">Receiver</dt>
                  <dd className="t-mono">{k.receiver}</dd>
                  <dt className="ink-3">Methods</dt>
                  <dd className="t-mono">{k.methods.join(", ")}</dd>
                  <dt className="ink-3">Allowance</dt>
                  <dd>{k.allowance}</dd>
                </>
              ) : null}
              <dt className="ink-3">Cannot</dt>
              <dd>{k.cannot}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}
