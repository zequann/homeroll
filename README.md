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
