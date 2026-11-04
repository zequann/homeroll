"use client";

import { useState, useTransition } from "react";
import { signInWorker } from "@/app/session-actions";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import styles from "./worker.module.css";

const DEMO_CODE = "123456";

/** Phone number + OTP, mocked (SPEC §9.2). No SMS is sent; the server holds the demo key. */
export function WorkerSignIn() {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (step === "phone") {
    return (
      <div className={styles.send}>
        <div className={styles.recipient}>
          <span className="t-caption ink-3">Your phone number</span>
          <span className="t-headline">+60 •• ••• 0000</span>
        </div>
        <Button fullWidth onClick={() => setStep("code")}>
          Send code
        </Button>
      </div>
    );
  }
  return (
    <form
      className={styles.send}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const result = await signInWorker(code);
          if (!result.ok) setError("That code is not right. Check it and try again.");
        });
      }}
    >
      <div className={styles.legTop}>
        <span className="t-caption ink-2">Demo code: {DEMO_CODE}. No SMS was sent.</span>
        <Badge>Mock sign-in</Badge>
      </div>
      <label className={styles.field}>
        <span className={styles.fieldPrefix}>Code</span>
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          aria-invalid={error !== null}
          onChange={(e) => {
            setCode(e.target.value);
            setError(null);
          }}
        />
      </label>
      {error ? (
        <p className={`t-caption ${styles.error}`} role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" fullWidth pending={pending} pendingLabel="Signing in…">
        Sign in
      </Button>
    </form>
  );
}
