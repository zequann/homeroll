"use client";

import { UploadSimple } from "@phosphor-icons/react";
import { useRef, useState, useTransition } from "react";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import type { InvoiceAgentResult } from "@/lib/agents/invoice-agent";
import { MAX_INVOICE_BYTES } from "@/lib/agents/upload-limits";
import { uploadInvoice } from "../actions";
import { AgentReport } from "./AgentReport";
import styles from "./owner.module.css";

/** Upload → live check list → grade (SPEC §9.1). The offer appears on the invoice's own row. */
export function InvoiceUpload() {
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<InvoiceAgentResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const pick = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setReport(null);
    setFileName(file.name);
    if (file.size > MAX_INVOICE_BYTES) {
      setError("That file is too big. Invoice PDFs here are well under 512 KB.");
      return;
    }
    const form = new FormData();
    form.set("file", file);
    start(async () => {
      try {
        const outcome = await uploadInvoice(form);
        if (outcome.ok) setReport(outcome.result);
        else setError(outcome.message);
      } catch {
        setError("The upload did not finish. Try again.");
      }
    });
    // The same file can be chosen again, for example to see the pool refuse it.
    if (input.current) input.current.value = "";
  };

  return (
    <div className={styles.upload}>
      <div className={styles.uploadRow}>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          aria-label="Invoice PDF"
          tabIndex={-1}
          onChange={(e) => pick(e.target.files?.[0])}
        />
        <Button
          variant="tinted"
          size="small"
          icon={<UploadSimple size={20} />}
          pending={pending}
          pendingLabel="Checking…"
          onClick={() => input.current?.click()}
        >
          Upload invoice
        </Button>
        <span className="t-caption ink-3">
          {fileName ?? "A PDF invoice. Download one below to try it."}
        </span>
        <Badge>Mock model</Badge>
      </div>
      {error ? (
        <p className={`t-caption ${styles.bad}`} role="alert">
          {error}
        </p>
      ) : null}
      {report ? (
        <div aria-live="polite">
          <p className={styles.uploadResult}>
            {/* A re-upload fails the registry check, so its grade says nothing about the invoice */}
            {report.attest.ok
              ? `${report.invoiceNumber}: Grade ${report.grade}${report.grade === "D" ? ". No advance." : ""}`
              : `${report.invoiceNumber} is already registered.`}
          </p>
          <AgentReport result={report} />
        </div>
      ) : null}
    </div>
  );
}
