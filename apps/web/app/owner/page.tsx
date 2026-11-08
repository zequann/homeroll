import { z } from "zod";
import { Money } from "@/components/Money";
import { Segmented } from "@/components/Segmented";
import { getFixtures, syncLiveCompany } from "@/lib/near";
import { loadPayoutPanel } from "@/lib/payout/server";
import { loadOwnerView } from "@/lib/views/owner";
import { Activity } from "./_components/Activity";
import { AgentKeys } from "./_components/AgentKeys";
import { ConfidentialPayout } from "./_components/ConfidentialPayout";
import { Invoices } from "./_components/Invoices";
import styles from "./_components/owner.module.css";
import { PayLines } from "./_components/PayLines";
import { TreasuryHero } from "./_components/TreasuryHero";
import { Workers } from "./_components/Workers";

export const metadata = { title: "Owner · Homeroll" };

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
  await syncLiveCompany();
  const tab = tabSchema.parse((await searchParams).tab);
  const [view, payout] = await Promise.all([
    loadOwnerView(tab),
    loadPayoutPanel(getFixtures().company.accountId),
  ]);

  return (
    <main className="page">
      <div className={styles.console}>
        <section className={styles.panel} aria-labelledby="owner-title">
          {/* The toolbar already says where you are: the heading is for screen readers */}
          <h1 id="owner-title" className="sr-only">
            Owner
          </h1>

          <TreasuryHero
            companyName={view.companyName}
            treasurySen={view.treasurySen}
            treasuryUsdc={view.treasuryUsdc}
            bufferSen={view.bufferSen}
            periodLabel={view.periodLabel}
            facts={view.facts}
            showAdvanceShortcut={tab !== "invoices"}
          />

          <ConfidentialPayout payout={payout} network={view.mode} />

          <div className={styles.tabs}>
            <Segmented
              label="Owner sections"
              active={tab}
              items={TABS.map((t) => ({ ...t, href: `/owner?tab=${t.key}` }))}
            />
          </div>

          {tab === "pay-lines" ? <PayLines rows={view.payLines} /> : null}
          {tab === "invoices" && view.figures ? (
            <dl className={styles.stats}>
              <div>
                <dt className="t-caption ink-3">Advanced against invoices</dt>
                <dd>
                  <Money value={view.figures.advancedSen} decimals={2} />
                </dd>
              </div>
              <div>
                <dt className="t-caption ink-3">Lender pool available</dt>
                <dd>
                  <Money value={view.figures.poolCashSen} decimals={2} />
                </dd>
              </div>
            </dl>
          ) : null}
          {tab === "invoices" ? <Invoices rows={view.invoices} /> : null}
          {tab === "workers" ? <Workers rows={view.payees} onboarding={view.onboarding} /> : null}
          {tab === "agent-keys" ? <AgentKeys keys={view.keys} mode={view.mode} /> : null}
          {tab === "activity" ? <Activity rows={view.activity} /> : null}
        </section>
      </div>
    </main>
  );
}
