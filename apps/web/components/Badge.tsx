import styles from "./Badge.module.css";

/** Always the thing that is mocked: "Mock model", "Mock partner", "Sample quote", "Fake chain". */
export function Badge({ children }: { children: string }) {
  return <span className={`${styles.badge} t-caption`}>{children}</span>;
}
