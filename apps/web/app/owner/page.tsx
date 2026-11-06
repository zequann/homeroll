import { z } from "zod";
import { ResetDemoButton } from "@/components/ResetDemoButton";
import { Segmented } from "@/components/Segmented";
import { readSession } from "@/lib/session";
import { loadOwnerView } from "@/lib/views/owner";
import { loadRahimView } from "@/lib/views/rahim";
import { Activity } from "./_components/Activity";
import { AgentKeys } from "./_components/AgentKeys";
import { Invoices } from "./_components/Invoices";
import styles from "./_components/owner.module.css";
import { PayLines } from "./_components/PayLines";
import { TreasuryHero } from "./_components/TreasuryHero";
import { WorkerPreview } from "./_components/WorkerPreview";
import { Workers } from "./_components/Workers";

export const metadata = { title: "Owner console · Homeroll" };

const TABS = [
  { key: "pay-lines", label: "Pay lines" },
  { key: "invoices", label: "Invoices" },
  { key: "workers", label: "Workers" },
  { key: "agent-keys", label: "Agent keys" },
  { key: "activity", label: "Activity" },
] as const;
const tabSchema = z
  .enum(["pay-lines", "invoices", "workers", "agent-keys", "activity"])
  .catch("pay-lines");

export default async function OwnerPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ tab: rawTab }, view, rahim, session] = await Promise.all([
    searchParams,
    loadOwnerView(),
    loadRahimView(),
    readSession(),
  ]);
  const tab = tabSchema.parse(rawTab);
  const connected = session?.role === "Owner";
  const preview = { balanceSen: rahim.balanceSen, usdcHint: rahim.usdcHint, wage: rahim.wage };

  return (
    <main className="page">
      <div className={styles.pair}>
        <section className={styles.panel} aria-labelledby="owner-title">
          <div className={styles.headerRow}>
            <h1 id="owner-title" className="t-title">
              Owner console
            </h1>
            <ResetDemoButton />
          </div>

          <div className={styles.rowPreview}>
            <WorkerPreview data={preview} variant="row" />
          </div>

          <TreasuryHero
            companyName={view.companyName}
            treasurySen={view.treasurySen}
            treasuryUsdc={view.treasuryUsdc}
            bufferSen={view.bufferSen}
            periodLabel={view.periodLabel}
            facts={view.facts}
            connected={connected}
            canFund={view.mode === "testnet"}
          />

          <div className={styles.tabs}>
            <Segmented
              label="Owner sections"
              active={tab}
              items={TABS.map((t) => ({ ...t, href: `/owner?tab=${t.key}` }))}
            />
          </div>

          {tab === "pay-lines" ? <PayLines rows={view.payLines} connected={connected} /> : null}
          {tab === "invoices" ? <Invoices rows={view.invoices} connected={connected} /> : null}
          {tab === "workers" ? (
            <Workers rows={view.payees} connected={connected} onboarding={view.onboarding} />
          ) : null}
          {tab === "agent-keys" ? <AgentKeys keys={view.keys} mode={view.mode} /> : null}
          {tab === "activity" ? <Activity rows={view.activity} /> : null}
        </section>

        <aside className={styles.satellite} aria-label="Rahim's phone">
          <WorkerPreview data={preview} />
        </aside>
      </div>
    </main>
  );
}
