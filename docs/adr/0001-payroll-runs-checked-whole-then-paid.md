# Payroll runs are checked whole, then paid in batches

A payroll run goes to the payroll contract in two steps. `submit_run` checks every line at once (active payee, wage cap, each payee once per period, open period, buffer) and reserves the total from the treasury; `pay_run` then pays the reserved lines in batches until the run is done. We split it because one call cannot carry enough token transfers for a large employer, and checking a run chunk by chunk would let a bad line in a late chunk fail after earlier chunks were already paid. `pay_run` takes only a run id, so the payroll agent's key can carry out a run the contract approved but cannot change it.

## Considered options

- **One `run_payroll` call with every line.** Truly all-or-nothing, but only up to the number of transfers that fit in one call's gas (an estimated 45–60 under the 1000 Tgas limit, not yet measured). A larger employer could not use it.
- **Chunks checked one call at a time, plus a view call that checks the whole run first.** A fooled agent can skip the view call, so the guard would no longer live in the contract.

## Consequences

- Runs have ids. An employer may submit several runs for a period (for example to pay a missed worker), but a payee is paid at most once per period.
- Reserved money returns to the treasury when a transfer fails, when a line is skipped because its payee was removed, or when the owner cancels the run. The agent's key cannot cancel.
