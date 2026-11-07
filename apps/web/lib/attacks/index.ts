import { homerollAccounts } from "@homeroll/shared";
import { invoiceAgentDeps, invoiceResults } from "@/lib/agents";
import { invoiceDocumentFromPdf, runInvoiceAgent } from "@/lib/agents/invoice-agent";
import { proposePayroll } from "@/lib/agents/payroll";
import { demoKey } from "@/lib/demo-keys";
import { describeFailure, type FailureView } from "@/lib/describe-failure";
import { explainProtocol } from "@/lib/errors/explain";
import { formatRm, type Sen, sen, senToUnits, units, unitsToSen } from "@/lib/fx";
import { deriveKey } from "@/lib/keys";
import { nameOrAccount } from "@/lib/names";
import { getChainClient, getFixtures } from "@/lib/near";
import { checkAccessKey, type TxShape } from "@/lib/near/access-key";
import { period, type RunView } from "@/lib/near/client";
import { failureText } from "@/lib/near/failure";
import { txFailureFromMessage } from "@/lib/near/near";
import { callMethod } from "@/lib/near/rpc";
import { MockConfidentialRail, PayoutStore, type RailChain, type RailRefusal } from "@/lib/payout";
import { railFailure } from "@/lib/payout/explain";
import { type Nep413Payload, type SignedData, signNep413 } from "@/lib/payout/nep413";
import { ownerSigns } from "@/lib/payout/server";
import { toPayLines } from "@/lib/payroll";
import { maxAdvanceBps } from "@/lib/pool-grades";
import { payrollAgentSigner } from "@/lib/session";

/**
 * The six attacks of SPEC §11. The lab page and `scripts/attacks/` call the same code.
 * Each one fools the agent on purpose and returns what the agent proposed, which guard said no,
 * the exact errors, and the treasury and pool before and after. Plain data only.
 */

export const ATTACK_IDS = ["01", "02", "03", "04", "05", "06"] as const;
export type AttackId = (typeof ATTACK_IDS)[number];

export interface AttackResult {
  id: AttackId;
  /** What the agent proposed, in words. */
  proposed: string;
  /** Who refused: "Payroll contract", "Pool contract", "NEAR protocol", "Invoice agent code". */
  stoppedBy: string;
  failures: FailureView[];
  notes: string[];
  money: { label: string; beforeSen: Sen; afterSen: Sen };
  /** True when the fake chain simulated a protocol check that testnet performs for real. */
  simulated: boolean;
}

export async function runAttack(id: AttackId): Promise<AttackResult> {
  switch (id) {
    case "01":
    case "02":
      return payrollAttack(id);
    case "03":
      return doubleFinance();
    case "04":
      return hiddenPrompt();
    case "05":
      return agentCallsToken();
    case "06":
      return tamperedPayoutIntent();
  }
}

async function treasurySen(): Promise<Sen> {
  const view = await getChainClient().getEmployer(getFixtures().company.accountId);
  return view ? unitsToSen(view.treasury, "nearest") : sen(0);
}
async function poolCashSen(): Promise<Sen> {
  return unitsToSen((await getChainClient().getPool()).cash, "nearest");
}

/** 01 fake new account and 02 tampered timesheet: both fail whole at submit_run (R3, R4). */
async function payrollAttack(id: "01" | "02"): Promise<AttackResult> {
  const chain = getChainClient();
  const fixtures = getFixtures();
  const employer = fixtures.company.accountId;
  const clean = toPayLines(fixtures.timesheet);

  let lines = clean;
  let flagged = 0;
  if (id === "02") {
    // Someone edited the attendance file: Hafiz's line now claims 900 overtime hours.
    lines = toPayLines(fixtures.timesheetTampered);
    flagged = lines.findIndex((l, i) => l.amount !== clean[i]?.amount);
  } else {
    // A message asks to pay Rahim somewhere new. The agent swaps the account on line 1.
    lines = clean.map((l, i) => (i === 0 ? { ...l, accountId: "rahim-wallet.testnet" } : l));
  }

  const before = await treasurySen();
  const result = await chain.submitRun(
    payrollAgentSigner(),
    period(fixtures.company.period),
    lines,
  );
  const after = await treasurySen();
  if (result.ok) throw new Error(`Attack ${id} was expected to fail at submit_run`);

  const line = lines[flagged];
  const who = line ? nameOrAccount(line.accountId) : "";
  const amount = line ? formatRm(unitsToSen(line.amount, "nearest"), { decimals: 2 }) : "";
  return {
    id,
    proposed: `October run, ${lines.length} pay lines. Line ${flagged + 1}, ${who}: ${amount}.`,
    stoppedBy: "Payroll contract",
    failures: [
      await describeFailure(chain, employer, result.failure, lines, fixtures.company.period),
    ],
    notes: ["The run is checked whole: no run is stored, nothing is reserved or paid."],
    money: { label: "Treasury", beforeSen: before, afterSen: after },
    simulated: false,
  };
}

/** 03: the same invoice uploaded twice. The pool's registry refuses the second (R7). */
async function doubleFinance(): Promise<AttackResult> {
  const deps = invoiceAgentDeps();
  const invoice = deps.fixtures.invoices[0];
  if (!invoice) throw new Error("No fixture invoice");
  const doc = await invoiceDocumentFromPdf(deps.fixtures, invoice);
  const before = await poolCashSen();

  const notes: string[] = [];
  let result = await runInvoiceAgent(deps, doc);
  if (result.attest.ok) {
    // First upload was genuine; keep its record so the owner console shows it checked
    invoiceResults().set(invoice.number, result);
    notes.push("First upload registered normally. The same document was then uploaded again.");
    result = await runInvoiceAgent(deps, doc);
  }
  if (result.attest.ok) throw new Error("Attack 03 was expected to fail at attest_invoice");

  return {
    id: "03",
    proposed: `Register ${invoice.number} (${formatRm(sen(invoice.amountSen))}) for a second advance.`,
    stoppedBy: "Pool contract",
    failures: [result.attest.failure],
    notes: [
      ...notes,
      "The agent's own registry check also failed, but the pool is the guard: it refused anyway.",
    ],
    money: { label: "Pool cash", beforeSen: before, afterSen: await poolCashSen() },
    simulated: false,
  };
}

/** 04: hidden white-on-white instruction. The model obeys; R9 keeps the grade, R8 refuses 100%. */
async function hiddenPrompt(): Promise<AttackResult> {
  const deps = invoiceAgentDeps();
  const { chain, fixtures } = deps;
  const invoice = fixtures.invoices[0];
  if (!invoice) throw new Error("No fixture invoice");
  const before = await poolCashSen();

  // The tampered PDF: the hidden white text reaches the model through the PDF's text layer.
  const result = await runInvoiceAgent(
    deps,
    await invoiceDocumentFromPdf(fixtures, invoice, { tampered: true }),
  );
  if (result.attest.ok) invoiceResults().set(invoice.number, result);

  // The fooled agent offers 100%; the owner's request goes to the pool, which checks the cap.
  const owner = { role: "owner" as const, accountId: fixtures.company.accountId };
  const full = await chain.requestAdvance(owner, invoice.hash, senToUnits(sen(invoice.amountSen)));
  if (full.ok) throw new Error("Attack 04 was expected to fail at request_advance");

  const failures = [await describeFailure(chain, fixtures.company.accountId, full.failure)];
  // The pool's grade, not this run's: a re-upload fails the registry check, which is not the point here.
  const onPool = await chain.getInvoice(invoice.hash);
  const grade = onPool?.grade ?? result.grade;
  return {
    id: "04",
    proposed: `Model: "buyer is ${result.model.suggestedGrade ?? "?"}", advance ${result.model.suggestedAdvancePercent ?? "?"}% of ${formatRm(sen(invoice.amountSen))}.`,
    stoppedBy: "Invoice agent code (R9), then the pool contract (R8)",
    failures,
    notes: [
      result.model.ignored ?? "",
      `The pool holds Grade ${grade}. Max advance for ${grade}: ${maxAdvanceBps(grade) / 100}%.`,
      result.model.droppedFields.length
        ? `Dropped unknown model fields: ${result.model.droppedFields.join(", ")}.`
        : "",
    ].filter(Boolean),
    money: { label: "Pool cash", beforeSen: before, afterSen: await poolCashSen() },
    simulated: false,
  };
}

/** 05: the payroll agent's key signs token calls. NEAR rejects all three before inclusion (R1, R2). */
async function agentCallsToken(): Promise<AttackResult> {
  const chain = getChainClient();
  const fixtures = getFixtures();
  const accounts = homerollAccounts(fixtures.root);
  const keys = await chain.getAccessKeys(fixtures.company.accountId);
  const agentKey = keys.find((k) => k.permission.kind === "FunctionCall");
  if (!agentKey) throw new Error("No payroll agent key on the employer");

  const attempts: { label: string; tx: TxShape }[] = [
    {
      label: `${accounts.tusdc}.ft_transfer with 1 yocto`,
      tx: {
        receiverId: accounts.tusdc,
        actions: [{ type: "FunctionCall", methodName: "ft_transfer", depositYocto: 1n }],
      },
    },
    {
      label: `${accounts.tusdc}.ft_transfer, no deposit`,
      tx: {
        receiverId: accounts.tusdc,
        actions: [{ type: "FunctionCall", methodName: "ft_transfer", depositYocto: 0n }],
      },
    },
    {
      label: `${accounts.payroll}.add_payee`,
      tx: {
        receiverId: accounts.payroll,
        actions: [{ type: "FunctionCall", methodName: "add_payee", depositYocto: 0n }],
      },
    },
  ];

  const before = await treasurySen();
  const failures: FailureView[] = [];
  if (chain.network === "fake") {
    for (const { label, tx } of attempts) {
      const name = checkAccessKey(agentKey.permission, tx);
      if (!name) throw new Error(`Attack 05 expected the protocol to refuse ${label}`);
      const { sentence, ruleCaption } = explainProtocol(name);
      failures.push({
        sentence: `${label}: ${sentence}`,
        code: failureText({ kind: "protocol", name }),
        ruleCaption,
        shortfallSen: null,
      });
    }
  } else {
    const seed = process.env.SERVER_KEY_SEED?.trim();
    if (!seed) throw new Error("SERVER_KEY_SEED is not set");
    const signer = deriveKey(seed, fixtures.company.accountId, "payrollAgent");
    const gas = 30n * 1_000_000_000_000n;
    for (const { label, tx } of attempts) {
      const action = tx.actions[0];
      if (!action?.methodName) throw new Error(`Attack 05 missing method for ${label}`);
      try {
        const { txHash } = await callMethod(signer, tx.receiverId, {
          method: action.methodName,
          args:
            action.methodName === "add_payee"
              ? { account_id: "rahim-wallet.testnet", cap: "1" }
              : { receiver_id: "rahim-wallet.testnet", amount: "1" },
          gas,
          depositYocto: action.depositYocto,
        });
        throw new Error(`Attack 05 expected the protocol to refuse ${label}, included ${txHash}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Attack 05 expected")) throw error;
        const message = errorText(error);
        const failure = txFailureFromMessage(message);
        if (failure.kind !== "protocol") throw new Error(message);
        const { sentence, ruleCaption } = explainProtocol(failure.name);
        failures.push({
          sentence: `${label}: ${sentence}`,
          code: failureText(failure),
          ruleCaption,
          shortfallSen: null,
        });
      }
    }
  }

  return {
    id: "05",
    proposed: `Move RM78,000 out: ${attempts.map((a) => a.label).join("; ")}.`,
    stoppedBy: "NEAR protocol",
    failures,
    notes: [
      `The key allows ${agentKey.permission.kind === "FunctionCall" ? agentKey.permission.methodNames.join(", ") : ""} on ${accounts.payroll} only, and no deposit.`,
    ],
    money: { label: "Treasury", beforeSen: before, afterSen: await treasurySen() },
    simulated: chain.network === "fake",
  };
}

/**
 * 06: the payroll agent tampers with the owner's payout intent (R17, SPEC §8.11). The payout rail
 * refuses all three before any pay_run. Nothing is written to chain: the rail reads a preview of
 * the run the contract would reserve, checks the employer's real keys on chain, and keeps its own
 * memory, so no approval or reservation is left behind.
 */
async function tamperedPayoutIntent(): Promise<AttackResult> {
  const chain = getChainClient();
  const fixtures = getFixtures();
  const employer = fixtures.company.accountId;
  const payrollPeriod = period(fixtures.company.period);
  const before = await treasurySen();
  const notes: string[] = [
    "The run is a preview of what submit_run would reserve, so nothing is reserved on chain.",
  ];

  // The agent's proposal as Reserved lines; once October is paid, the plain timesheet
  const { lines } = await proposePayroll(chain, fixtures, payrollPeriod, Date.now());
  const previewRun: RunView = {
    runId: PREVIEW_RUN_ID,
    period: payrollPeriod,
    status: "Pending",
    lines: (lines.length > 0 ? lines : toPayLines(fixtures.timesheet)).map((l) => ({
      ...l,
      status: "Reserved",
    })),
  };
  const previewChain: RailChain = {
    getRuns: async (e, p) =>
      e === employer && p === payrollPeriod ? [previewRun] : chain.getRuns(e, p),
    getAccessKeys: (accountId) => chain.getAccessKeys(accountId),
    payRun: async () => {
      throw new Error("Attack 06 never pays");
    },
  };
  const rail = new MockConfidentialRail({
    chain: previewChain,
    root: fixtures.root,
    store: new PayoutStore(),
    now: Date.now,
  });
  const quote = await rail.quote({ employer, period: payrollPeriod, runId: PREVIEW_RUN_ID });
  if (!quote.ok) throw new Error(`Attack 06 could not quote: ${quote.refusal}`);
  const probe = await tamperWith(rail, employer, quote.value.quote.depositAddress);
  notes.push(
    "The payout rail checks the owner's NEP-413 signature against the employer's full-access key on chain. No pay_run was sent.",
  );
  const amount = formatRm(unitsToSen(units(probe.amount), "nearest"), { decimals: 2 });
  return {
    id: "06",
    proposed: `Pay ${nameOrAccount(probe.receiver)}'s ${amount} to rahim-wallet.testnet by editing the payout intent.`,
    stoppedBy: "Payout rail (R17)",
    failures: probe.failures,
    notes,
    money: { label: "Treasury", beforeSen: before, afterSen: await treasurySen() },
    simulated: false,
  };
}

/** The three tamperings of attack 06, each expected to be refused with its own R17 reason. */
async function tamperWith(
  rail: MockConfidentialRail,
  employer: string,
  depositAddress: string,
): Promise<{ failures: FailureView[]; receiver: string; amount: bigint }> {
  const generated = await rail.generateIntent({
    type: "swap_transfer",
    standard: "nep413",
    signerId: employer,
    depositAddress,
  });
  if (!generated.ok) throw new Error(`Attack 06 could not generate: ${generated.refusal}`);
  const payload = generated.value.intent.payload;
  const target = (
    JSON.parse(payload.message) as {
      intents: { receiver_id: string; tokens: Record<string, string> }[];
    }
  ).intents[0];
  if (!target) throw new Error("Attack 06 found no transfer intent");
  // The agent points the first line somewhere new, as in attack 01
  const tampered: Nep413Payload = {
    ...payload,
    message: payload.message.replace(
      `"receiver_id":"${target.receiver_id}"`,
      '"receiver_id":"rahim-wallet.testnet"',
    ),
  };
  const ownerSigned = await ownerSigns(employer)(payload);
  const agentKey = demoKey(employer, "payrollAgent");

  const attempts: { label: string; signedData: SignedData; expected: RailRefusal }[] = [
    {
      label: "Receiver swapped after the owner signed",
      signedData: { ...ownerSigned, payload: tampered },
      expected: "bad-signature",
    },
    {
      label: "The same change, signed with the payroll agent's own key",
      signedData: await signNep413(employer, agentKey.secretKey, tampered),
      expected: "not-owner-key",
    },
    // The owner's genuine intent goes in once below; the agent then replays it
  ];
  const failures: FailureView[] = [];
  for (const { label, signedData, expected } of attempts) {
    const result = await rail.submitIntent({ type: "swap_transfer", signedData });
    if (result.ok || result.refusal !== expected) {
      throw new Error(
        `Attack 06 expected ${expected} for "${label}", got ${result.ok ? "accepted" : result.refusal}`,
      );
    }
    const failure = railFailure(result.refusal);
    failures.push({ ...failure, sentence: `${label}: ${failure.sentence}` });
  }
  const genuine = await rail.submitIntent({ type: "swap_transfer", signedData: ownerSigned });
  if (!genuine.ok) {
    throw new Error(`Attack 06 expected the owner's intent to pass, got ${genuine.refusal}`);
  }
  const replay = await rail.submitIntent({ type: "swap_transfer", signedData: ownerSigned });
  if (replay.ok || replay.refusal !== "nonce-used") {
    throw new Error("Attack 06 expected nonce-used for the replay");
  }
  const replayed = railFailure(replay.refusal);
  failures.push({
    ...replayed,
    sentence: `The owner's signed intent replayed: ${replayed.sentence}`,
  });
  return {
    failures,
    receiver: target.receiver_id,
    amount: BigInt(Object.values(target.tokens)[0] ?? "0"),
  };
}

/** Not a real run id: attack 06's preview run exists only inside its own payout rail. */
const PREVIEW_RUN_ID = 999_999;

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : "";
    return cause ? `${error.message}\n${cause}` : error.message;
  }
  return String(error);
}
