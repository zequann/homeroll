# Homeroll

> Payroll that makes it all the way home.

Homeroll gives Malaysian SMEs an invoice advance, pays their foreign workers through a guarded payroll contract on NEAR, and lets workers send money home cheaply. AI agents propose payments; NEAR contracts and access keys decide.

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

## Try it

```bash
pnpm install
CHAIN_CLIENT=fake pnpm dev   # http://localhost:3000, fixture data, no chain needed
```

Open `/owner`, press **Connect wallet** and choose Perabot Jaya Sdn Bhd. On **Invoices**, press **Check with agent** on INV-2026-1043 (see four checks, Grade A, a RM120,000 offer and a "Mock model" badge), then **Take advance**, then **Run payroll**. `/worker` (connect as Rahim Uddin) shows RM1,950.00 within seconds; **Send home** and **Cash out** go through the relayer policy to mock partners. Back on **Invoices**, **Buyer paid** settles the invoice through the mock bank: the pool is repaid RM121,800 and the treasury gets RM28,200. `/lab` runs all five attacks; each shows the agent's proposal, who refused it and the exact error, and that no money moved. Without `NEAR_ROOT_ACCOUNT` the fake chain uses the stand-in root `homeroll-demo.testnet`; Next reads `.env.local` from `apps/web/`.
