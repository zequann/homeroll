import { CaretLeft } from "@phosphor-icons/react/ssr";
import { ButtonLink } from "@/components/Button";
import { getFixtures } from "@/lib/near";
import { readSession } from "@/lib/session";
import { loadRahimView } from "@/lib/views/rahim";
import { SendHome } from "../_components/SendHome";
import styles from "../_components/worker.module.css";

export const metadata = { title: "Send home · Homeroll" };

export default async function SendHomePage() {
  const [rahim, session] = await Promise.all([loadRahimView(), readSession()]);
  const family = getFixtures().workers[0]?.family;
  if (!family) throw new Error("Rahim has no family fixture");

  return (
    <main className="page">
      <div className={styles.stage}>
        <section className={styles.column} aria-labelledby="send-title">
          <div className={styles.back}>
            <ButtonLink href="/worker" variant="plain" size="small" icon={<CaretLeft size={20} />}>
              Home
            </ButtonLink>
          </div>
          <h1 id="send-title" className="t-title">
            Send home
          </h1>
          <SendHome
            balanceSen={rahim.balanceSen}
            connected={session?.key === "worker:w-7k2q9x"}
            recipient={family}
          />
        </section>
      </div>
    </main>
  );
}
