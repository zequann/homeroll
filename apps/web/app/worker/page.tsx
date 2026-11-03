import { PaperPlaneTilt } from "@phosphor-icons/react/ssr";
import { ButtonLink } from "@/components/Button";
import { PlaceholderRow } from "@/components/PlaceholderRow";
import { RollingMoney } from "@/components/RollingMoney";
import { ConnectButton } from "@/components/WalletButton";
import { readSession } from "@/lib/session";
import { loadRahimView } from "@/lib/views/rahim";
import { ActivityList, type WorkerActivityItem } from "./_components/ActivityList";
import { RefreshWhileVisible } from "./_components/RefreshWhileVisible";
import styles from "./_components/worker.module.css";

export const metadata = { title: "Worker · Homeroll" };

export default async function WorkerPage() {
  const [rahim, session] = await Promise.all([loadRahimView(), readSession()]);
  const connected = session?.key === "worker:w-7k2q9x";
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

          {connected ? (
            <ButtonLink href="/worker/send" fullWidth icon={<PaperPlaneTilt size={20} />}>
              Send home
            </ButtonLink>
          ) : (
            <ConnectButton account="worker:w-7k2q9x" fullWidth />
          )}
          <PlaceholderRow name="Cash out to DuitNow" caption="Not in this build." />

          <div className={styles.sectionLabel}>
            <ActivityList items={items} />
          </div>

          <p className={`t-caption ink-3 ${styles.footer}`}>Network fees: RM0.00</p>
        </section>
      </div>
    </main>
  );
}
