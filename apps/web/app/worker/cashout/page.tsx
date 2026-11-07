import { CaretLeft } from "@phosphor-icons/react/ssr";
import { redirect } from "next/navigation";
import { ButtonLink } from "@/components/Button";
import { guardPage } from "@/lib/page-access";
import { readSession } from "@/lib/session";
import { loadRahimView } from "@/lib/views/rahim";
import { CashOut } from "../_components/CashOut";
import styles from "../_components/worker.module.css";

export const metadata = { title: "Cash out · Homeroll" };

export default async function CashOutPage() {
  await guardPage("/worker/cashout");
  const [rahim, session] = await Promise.all([loadRahimView(), readSession()]);
  if (session?.key !== "worker:w-7k2q9x") redirect("/worker");

  return (
    <main className="page">
      <div className={styles.stage}>
        <section className={styles.column} aria-labelledby="cashout-title">
          <div className={styles.back}>
            <ButtonLink href="/worker" variant="plain" size="small" icon={<CaretLeft size={20} />}>
              Home
            </ButtonLink>
          </div>
          <h1 id="cashout-title" className="t-title">
            Cash out
          </h1>
          <CashOut balanceSen={rahim.balanceSen} />
        </section>
      </div>
    </main>
  );
}
