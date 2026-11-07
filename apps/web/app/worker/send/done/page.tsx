import { CheckCircle } from "@phosphor-icons/react/ssr";
import { redirect } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/Badge";
import { ButtonLink } from "@/components/Button";
import { formatRm, formatTaka, sen } from "@/lib/fx";
import { getMockLedger } from "@/lib/mock/ledger";
import { quoteWithSwap, SampleQuote } from "@/lib/remit";
import styles from "../../_components/worker.module.css";

export const metadata = { title: "Sent · Homeroll" };

export default async function SentPage({
  searchParams,
}: {
  searchParams: Promise<{ rm?: string; ref?: string }>;
}) {
  const params = await searchParams;
  const parsed = z.coerce.number().int().positive().max(100_000_000).safeParse(params.rm);
  // Only a mock ledger reference is shown back; anything else in the URL is dropped
  const ref = z
    .string()
    .regex(/^[A-Z]+-SYN-\d{6}$/)
    .safeParse(params.ref).data;
  if (!parsed.success) redirect("/worker");
  // The receipt holds the swap price actually used. Without one, fall back to a labelled sample.
  const receipt = getMockLedger()
    .list()
    .find((r) => r.ref === ref);
  const quote =
    receipt?.kind === "payout"
      ? quoteWithSwap(receipt.amountSen, receipt.swapBps, receipt.swapSource)
      : SampleQuote.quote(sen(parsed.data));

  return (
    <main className="page">
      <div className={styles.stage}>
        <section className={styles.column} aria-labelledby="sent-title">
          <div className={styles.done}>
            <CheckCircle size={40} weight="regular" className={styles.doneMark} aria-hidden />
            <h1 id="sent-title" className="t-title">
              Sent to Amma
            </h1>
            <p className={styles.receives}>{formatTaka(quote.takaOut)}</p>
            <p className="t-caption ink-3">From {formatRm(quote.amountSen, { decimals: 2 })}</p>
            {ref ? <p className="t-caption ink-3 t-mono">Receipt {ref}</p> : null}
          </div>
          <div className={styles.legs}>
            <div className={styles.leg}>
              <div className={styles.legTop}>
                <span className="t-headline">{quote.swap.label}</span>
                <Badge>{quote.swap.source === "live" ? "Live quote" : "Sample quote"}</Badge>
              </div>
              <span className="t-caption ink-3">
                Fee {formatRm(quote.swap.feeSen, { decimals: 2 })}
              </span>
            </div>
            <div className={styles.leg}>
              <div className={styles.legTop}>
                <span className="t-headline">{quote.payout.label}</span>
                <Badge>Mock partner</Badge>
              </div>
              <span className="t-caption ink-3">
                Fee {formatRm(quote.payout.feeSen, { decimals: 2 })}
              </span>
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
