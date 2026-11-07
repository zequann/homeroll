import Link from "next/link";
import { loadLandingSnapshot } from "@/lib/views/landing";
import { PayLines } from "./owner/_components/PayLines";
import { TreasuryHero } from "./owner/_components/TreasuryHero";
import { WorkerPreview } from "./owner/_components/WorkerPreview";
import styles from "./page.module.css";

const LINKS = [
  { href: "/owner", label: "Owner console" },
  { href: "/worker", label: "Worker app" },
  { href: "/lab", label: "Attack lab" },
  { href: "/lender", label: "Lender" },
] as const;

export default function LandingPage() {
  const snap = loadLandingSnapshot();
  return (
    <main className="page">
      <div className={styles.copy}>
        <h1 className={styles.sentence}>
          Homeroll advances cash against an SME's unpaid invoice, pays its foreign workers through a
          guarded payroll contract on NEAR, and lets them send money home.
        </h1>
        <nav className={styles.links} aria-label="Surfaces">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="link">
              {l.label}
            </Link>
          ))}
        </nav>
        <p className="t-caption ink-2">Who touches crypto? Only the lenders.</p>
      </div>

      <div
        className={styles.stage}
        role="img"
        aria-label="Owner console after October payroll, and Rahim's phone showing RM1,950.00 received"
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
                connected
                canFund={false}
              />
              <div className={styles.table}>
                <PayLines rows={snap.rows} caption={false} />
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
