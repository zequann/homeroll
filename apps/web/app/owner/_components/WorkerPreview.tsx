import { CaretRight } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { Money } from "@/components/Money";
import { RollingMoney } from "@/components/RollingMoney";
import type { Sen } from "@/lib/fx";
import styles from "./owner.module.css";

export interface WorkerPreviewData {
  balanceSen: Sen;
  usdcHint: string;
  wage: { label: string; amountSen: Sen } | null;
}

/**
 * Rahim's phone, the satellite beside the owner console: cause (Run payroll) and effect (his wage)
 * on one screen. Not a drawn phone: no bezel, no fake status bar.
 */
export function WorkerPreview({
  data,
  variant = "card",
  rolling = true,
}: {
  data: WorkerPreviewData;
  variant?: "card" | "row";
  /** The landing stage shows a frozen snapshot, so its number does not roll. */
  rolling?: boolean;
}) {
  if (variant === "row") {
    return (
      <Link href="/worker" className={styles.previewRow}>
        <span>Rahim's phone · </span>
        <Money value={data.balanceSen} decimals={2} />
        <CaretRight size={14} weight="fill" aria-hidden />
      </Link>
    );
  }
  return (
    <div className={styles.preview}>
      <div className={styles.previewHead}>
        <span className="t-caption ink-3">Rahim's phone</span>
        <Link href="/worker" className="link t-caption">
          Open
        </Link>
      </div>
      <div className={styles.previewBalance}>
        {rolling ? (
          <RollingMoney value={data.balanceSen} decimals={2} />
        ) : (
          <Money value={data.balanceSen} decimals={2} />
        )}
      </div>
      {data.wage ? (
        <>
          <p className="t-caption ink-3">{data.usdcHint}</p>
          <p className={styles.previewRowItem}>
            <span>{data.wage.label}</span>
            <span className={styles.plus}>
              +<Money value={data.wage.amountSen} decimals={2} />
            </span>
          </p>
        </>
      ) : (
        <p className="t-caption ink-2">October wage arrives when Coffee Factory runs payroll.</p>
      )}
    </div>
  );
}
