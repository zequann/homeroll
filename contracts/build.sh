#!/usr/bin/env bash
# Builds every contract to contracts/target/near/<crate>/<crate>.wasm with `cargo near`,
# the same build the integration tests use.
set -euo pipefail
cd "$(dirname "$0")"
for contract in tusdc factory payroll pool; do
  cargo near build non-reproducible-wasm --locked --manifest-path "$contract/Cargo.toml"
done
