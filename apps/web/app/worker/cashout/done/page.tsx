import { CheckCircle } from "@phosphor-icons/react/ssr";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/Badge";
import { ButtonLink } from "@/components/Button";
import { formatRm } from "@/lib/fx";
import { getMockLedger } from "@/lib/mock/ledger";
import { syncLiveCompany } from "@/lib/near";
import styles from "../../_components/worker.module.css";

export const metadata = { title: "Cashed out · Homeroll" };

export default async function CashedOutPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  await syncLiveCompany();
  const ref = z
    .string()
    .regex(/^DN-SYN-\d{6}$/)
    .safeParse((await searchParams).ref).data;
  const receipt = ref ? await getMockLedger().find(ref) : null;
  if (receipt?.kind !== "duitnow") redirect("/worker");

  return (
    <main className="page">
      <div className={styles.stage}>
        <section className={styles.column} aria-labelledby="cashed-title">
          <div className={styles.done}>
            <CheckCircle size={40} weight="regular" className={styles.doneMark} aria-hidden />
            <h1 id="cashed-title" className="t-title">
              On its way
            </h1>
            <p className={styles.receives}>{formatRm(receipt.rmOutSen, { decimals: 2 })}</p>
            <p className="t-caption ink-3">To {receipt.destination} by DuitNow</p>
          </div>
          <div className={styles.legs}>
            <div className={styles.leg}>
              <div className={styles.legTop}>
                <span className="t-headline">DuitNow reference</span>
                <Badge>Mock partner</Badge>
              </div>
              <span className="t-caption ink-3 t-mono">{receipt.ref}</span>
            </div>
          </div>
          <ButtonLink href="/worker" fullWidth>
            Done
          </ButtonLink>
        </section>
      </div>
    </main>
  );
}
