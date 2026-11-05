# Homeroll

> Payroll that makes it all the way home.

Homeroll gives Malaysian SMEs an invoice advance, pays their foreign workers through a guarded payroll contract on NEAR, and lets workers send money home cheaply. AI agents propose payments; NEAR contracts and access keys decide.

## What it is

- **Owner, on the web, in RM:** turn an unpaid invoice into an advance the same day, then pay foreign workers through a guarded payroll contract.
- **Worker, on a phone, in RM and taka:** receive wages with no seed phrase and no gas, send money home, or cash out.
- **Lender, in USDC:** fund the pool and earn the advance fees.

Who touches crypto? Only the lenders. Stablecoins are the back-office rails.

## The problem

A Malaysian SME waits about 60 days to be paid on an invoice, but its foreign workers must be paid this month. Those workers then lose about 7.51% sending money from Malaysia to Bangladesh (World Bank Remittance Prices Worldwide, Q3 2025, sending USD 200). AI agents could do the paperwork, but a fooled agent holding a wallet key can lose all of the money.

## How NEAR fits

On other chains you bolt safety onto the wallet. On NEAR, the account is the guard.

- **Function-call keys:** the payroll agent's key can call only `payroll.submit_run` and `payroll.pay_run`, and it cannot attach a deposit. NEAR rejects anything else before the transaction is included, so the agent can never satisfy `ft_transfer`'s 1-yocto requirement.
- **Guards in contracts:** the payroll contract checks a whole run before paying any of it (wage cap, active payee, once per period, treasury buffer). The pool enforces one advance per invoice and caps each advance at the grade limit, never above 80%.
- **Meta-transactions:** a relayer pays gas, so workers need no NEAR. It pays for one kind of transfer only.
- **Named sub-accounts:** workers get random `w-xxxxxx` accounts, so the chain shows amounts but not who is paid.
- **NEAR Intents:** Send home can show a live dry-run quote for the swap leg. No funds move.

Tracks: Real-World Money (`realworld`), AI Security & Defense (`security`).

## Stack

Exact versions, pinned where each is declared.

| Part | Version | Pinned in |
|---|---|---|
| Rust toolchain | 1.93.0 (+ `wasm32-unknown-unknown`) | `rust-toolchain.toml` |
| `cargo-near` (build and deploy) | 0.22.0 | CI install step |
| `near-sdk` | 5.29.1 | `contracts/Cargo.toml` |
| `near-api` + `near-sandbox` (contract integration tests) | 0.8.6 + 0.3.16 | `contracts/Cargo.toml` |
| `cargo-near-build` (builds contracts inside tests) | 0.11.5 | `contracts/Cargo.toml` |
| Node.js | 24 | `.nvmrc` |
| pnpm | 10.34.6 | `package.json` `packageManager` |
| TypeScript | 6.0.3 | `pnpm-workspace.yaml` catalog |
| Vitest | 5.0.4 | `pnpm-workspace.yaml` catalog |
| Biome (lint + format) | 2.5.15 | `pnpm-workspace.yaml` catalog |
| Zod | 4.6.7 | `pnpm-workspace.yaml` catalog |
| Next.js (App Router) | 16.4.4 | `apps/web/package.json` |
| React + React DOM | 19.3.1 | `apps/web/package.json` |
| Motion (`motion/react`) | 14.9.0 | `apps/web/package.json` |
| Phosphor Icons (`@phosphor-icons/react`) | 2.1.10 | `apps/web/package.json` |
| `@types/react`, `@types/react-dom` | 19.3.0 | `apps/web/package.json` |
| `near-api-js` | 7.4.0 | `apps/web/package.json` |
| `borsh` | 2.0.0 | `apps/web/package.json` |
| `pdf-lib` (invoice PDFs, pure JS) | 1.17.1 | `packages/shared/package.json` |

## Try it

```bash
pnpm install
CHAIN_CLIENT=fake pnpm dev   # http://localhost:3000, fixture data, no chain needed
```

The PDFs in `fixtures/invoices/` come from the invoice template; regenerate them with `pnpm fixtures:invoices`.

Open `/owner`, press **Connect wallet** and choose Perabot Jaya Sdn Bhd. On **Invoices**, press **Check with agent** on INV-2026-1043 (see four checks, Grade A, a RM120,000 offer and a "Mock model" badge), then **Take advance**, then **Run payroll**. `/worker` (connect as Rahim Uddin) shows RM1,950.00 within seconds; **Send home** and **Cash out** go through the relayer policy to mock partners. Back on **Invoices**, **Buyer paid** settles the invoice through the mock bank: the pool is repaid RM121,800 and the treasury gets RM28,200. `/lab` runs all five attacks; each shows the agent's proposal, who refused it and the exact error, and that no money moved. On **Workers**, remove a worker while a run is reserved (**Reserve only**): **Finish paying** skips their line and returns the money. **Add back** starts the 48-hour hold, and **Pay missed worker** is refused with `ERR_PAYEE_NOT_ACTIVE` until it ends. On `/worker`, the sign-in code is shown on screen (mock, no SMS). Set `INTENTS_QUOTES=live` for a live NEAR Intents dry-run quote on Send home; no funds move. Without `NEAR_ROOT_ACCOUNT` the fake chain uses the stand-in root `homeroll-demo.testnet`; Next reads `.env.local` from `apps/web/`.

To try the upload, press **Download PDF** on an invoice, then **Upload invoice** on the same tab. Upload the tampered copy from `/lab` (attack 04): its text is white, so it looks clean, the model says "A+" and "100%", and the code keeps Grade A and an 80% cap.

## What is mocked

Every mock sits behind an interface, returns `"mock": true` and shows a badge.

| Part | Status |
|---|---|
| Invoice model | Mock (`MockInference`). It obeys hidden instructions on purpose, so attack 04 always fools it |
| MyInvois, bank and escrow, bKash payout, DuitNow | Mock partners |
| Worker sign-in | Mock code, shown on screen. No SMS is sent |
| Swap leg of Send home | Sample number by default; a live NEAR Intents dry-run quote with `INTENTS_QUOTES=live` |
| Fake chain (`CHAIN_CLIENT=fake`) | Simulates the contract rules. Attack 05 there is a labelled simulation of NEAR's access-key checks |

## Known limitations

1. Testnet only, with a mock stablecoin for large demo amounts.
2. Banks, MyInvois, DuitNow, bKash payout and the invoice model are mocked. Quotes can be live, but the transfers are mocked (NEAR Intents has no testnet).
3. The pool trusts the registered agent account. This build has no private inference or attestation; NEAR AI Cloud is the production path.
4. The invoice registry prevents double financing only within Homeroll.
5. Wage amounts are visible on-chain. Accounts are pseudonymous, so amounts cannot be tied to a person without our off-chain records. Confidential Intents is the production path.
6. The relayer's rules, including the per-transfer limit, are server policy, not on-chain.
7. Demo keys are held by the server. They never reach the browser.
8. Real-world operation would need licensed partners regulated by Bank Negara Malaysia.
9. A payee is paid at most once per period through payroll, so a top-up for a worker already paid is paid by the owner by hand.
10. The contract checks limits, not correctness: an agent can still propose a wrong amount below the wage cap, so the owner reviews the preview first.
11. The payout partner's 1.0% and the DuitNow off-ramp's 0.5% are assumptions, not quotes.
12. The mock model reads this project's invoice template only, so other PDFs are refused.

## Related work

OutLayer (a hackathon partner) keeps an agent's keys inside secure hardware and proves what code ran. Homeroll takes a different route: NEAR's own function-call keys make the agent's key unable to move money in the first place, and the payroll rules live in our contract.
