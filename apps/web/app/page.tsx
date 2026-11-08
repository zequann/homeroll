import { ButtonLink } from "@/components/Button";
import { syncLiveCompany } from "@/lib/near";
import { loadLandingSnapshot } from "@/lib/views/landing";
import { PayLines } from "./owner/_components/PayLines";
import { TreasuryHero } from "./owner/_components/TreasuryHero";
import { WorkerPreview } from "./owner/_components/WorkerPreview";
import styles from "./page.module.css";

export default async function LandingPage() {
  await syncLiveCompany();
  const snap = loadLandingSnapshot();
  return (
    <main className="page">
      <div className={styles.copy}>
        <h1 className={styles.sentence}>
          Homeroll advances cash against an SME's unpaid invoice, pays its foreign workers through a
          guarded payroll contract on NEAR, and lets them send money home.
        </h1>
        <div className={styles.cta}>
          <ButtonLink href="/owner">Start the demo</ButtonLink>
        </div>
        <p className="t-caption ink-2">
          One shared demo company: everyone who opens this site uses the same demo accounts, and
          each page signs as its own role on the server. Reset demo in the toolbar starts it over.
          Who touches crypto? Only the lenders.
        </p>
      </div>

      <div
        className={styles.stage}
        role="img"
        aria-label="Owner page after October payroll, and Rahim's phone showing RM1,950.00 received"
      >
        {/* A frozen picture of the real components: not interactive, not announced. */}
        <div inert aria-hidden="true">
          <div className={styles.owner}>
            <div className={styles.panel}>
              <TreasuryHero
                companyName={snap.companyName}
                treasurySen={snap.treasurySen}
                treasuryUsdc={snap.treasuryUsdc}
                bufferSen={snap.bufferSen}
                periodLabel={snap.periodLabel}
                facts={snap.facts}
              />
              <div className={styles.table}>
                <PayLines rows={snap.rows} caption={false} actions={false} />
              </div>
            </div>
          </div>
          <div className={styles.phone}>
            <WorkerPreview data={snap.preview} rolling={false} />
          </div>
        </div>
      </div>
    </main>
  );
}
