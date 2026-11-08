import { Bank, PaperPlaneTilt } from "@phosphor-icons/react/ssr";
import { ButtonLink } from "@/components/Button";
import { RollingMoney } from "@/components/RollingMoney";
import { syncLiveCompany } from "@/lib/near";
import { loadRahimView } from "@/lib/views/rahim";
import { ActivityList, type WorkerActivityItem } from "./_components/ActivityList";
import { RefreshWhileVisible } from "./_components/RefreshWhileVisible";
import styles from "./_components/worker.module.css";

export const metadata = { title: "Worker · Homeroll" };

export default async function WorkerPage() {
  await syncLiveCompany();
  const rahim = await loadRahimView();
  const items: WorkerActivityItem[] = [
    ...rahim.sends.map((s) => ({
      id: `send-${s.id}`,
      label: s.label,
      amountSen: -s.amountSen as WorkerActivityItem["amountSen"],
    })),
    ...(rahim.wage
      ? [{ id: "wage-oct", label: rahim.wage.label, amountSen: rahim.wage.amountSen }]
      : []),
  ];

  return (
    <main className="page">
      <div className={styles.stage}>
        <p className={`${styles.caption} t-body`}>
          Rahim's phone. His account is {rahim.accountId}. Only Homeroll's records know it is Rahim.
        </p>
        <section className={styles.column} aria-labelledby="worker-title">
          <RefreshWhileVisible />
          <h1 id="worker-title" className="t-title">
            Hi Rahim
          </h1>
          <div className={styles.balanceBlock}>
            <div className={styles.balance}>
              <RollingMoney value={rahim.balanceSen} decimals={2} />
            </div>
            <p className="t-caption ink-3">{rahim.usdcHint}</p>
          </div>

          <div className={styles.actions}>
            <ButtonLink href="/worker/send" fullWidth icon={<PaperPlaneTilt size={20} />}>
              Send home
            </ButtonLink>
            <ButtonLink href="/worker/cashout" variant="tinted" fullWidth icon={<Bank size={20} />}>
              Cash out
            </ButtonLink>
          </div>

          <div className={styles.sectionLabel}>
            <ActivityList items={items} />
          </div>

          <p className={`t-caption ink-3 ${styles.footer}`}>Network fees: RM0.00</p>
        </section>
      </div>
    </main>
  );
}
