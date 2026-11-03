use std::collections::BTreeSet;

use homeroll_common::errors::{
    ERR_ABOVE_WAGE_CAP, ERR_ALREADY_PAID, ERR_BELOW_BUFFER, ERR_DUPLICATE_PAYEE,
    ERR_PAYEE_NOT_ACTIVE, ERR_PERIOD_NOT_OPEN, ERR_TOO_MANY_LINES, ERR_TOO_MANY_PAYEES,
};
use homeroll_common::period::Period;
use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{AccountId, near};

use crate::config::Config;
use crate::run::{LineStatus, PayLine, Run, RunLine, RunView};
use crate::{Rejection, StorageKey};

/// One employer's treasury, payees, and runs (SPEC §7.3).
/// The only writer of this state: `lib.rs` asks it to change and does not touch its fields.
#[near(serializers = [borsh])]
pub(crate) struct Employer {
    /// tUSDC base units not reserved by any run.
    treasury: u128,
    /// Minimum the treasury must still hold after any run (R6).
    buffer: u128,
    /// True until the first run is submitted. While true, new payees are active at once (R3).
    onboarding: bool,
    /// Iterable for a later `get_payees` and for `payee_count`.
    payees: IterableMap<AccountId, Payee>,
    /// Append-only. The run id is the index, so the next id is `runs.len()`.
    runs: Vector<Run>,
    /// Run ids per canonical period, appended once in `reserve`.
    runs_by_period: LookupMap<String, Vec<u32>>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
pub(crate) struct Payee {
    /// Wage cap in base units: the most this payee may be paid for one period (R4).
    cap: u128,
    /// Block time (ns) from which the payee can be paid (R3).
    pub(crate) active_from: u64,
}

/// What `reserve` hands back to the shell for the return value and the event.
#[derive(Debug)]
pub(crate) struct SubmittedRun {
    pub(crate) run_id: u64,
    pub(crate) period: String,
    pub(crate) total: u128,
    pub(crate) line_count: u32,
}

/// Proof that checks 1–7 passed. Only `check_run` builds one and only `reserve` consumes one.
struct CheckedRun {
    period: Period,
    lines: Vec<(AccountId, u128)>,
    total: u128,
}

/// `get_employer` JSON.
#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct EmployerView {
    pub treasury: U128,
    pub buffer: U128,
    pub onboarding: bool,
    pub payee_count: u32,
}

impl Employer {
    pub(crate) fn new(employer: &AccountId, buffer: u128) -> Self {
        Self {
            treasury: 0,
            buffer,
            onboarding: true,
            payees: IterableMap::new(StorageKey::Payees {
                employer: employer.clone(),
            }),
            runs: Vector::new(StorageKey::Runs {
                employer: employer.clone(),
            }),
            runs_by_period: LookupMap::new(StorageKey::RunsByPeriod {
                employer: employer.clone(),
            }),
        }
    }

    /// Adds `account_id`, or replaces it if it is already a payee.
    /// Replacing is the same as remove plus add, which SPEC allows, so it grants no new power.
    pub(crate) fn add_payee(
        &mut self,
        account_id: AccountId,
        cap: u128,
        now: u64,
        config: &Config,
    ) -> Result<Payee, Rejection> {
        // R15: payee limit. A re-add does not grow storage.
        if !self.payees.contains_key(&account_id)
            && self.payees.len() >= config.max_payees_per_employer
        {
            return Err(Rejection::new(ERR_TOO_MANY_PAYEES));
        }
        // R3: active at once while onboarding, otherwise after the hold.
        let active_from = if self.onboarding {
            now
        } else {
            now + config.hold_ns
        };
        let payee = Payee { cap, active_from };
        self.payees.insert(account_id, payee);
        Ok(payee)
    }

    /// SPEC §7.3 steps 1–8. Checks borrow `&self`, so no check can write state.
    pub(crate) fn submit_run(
        &mut self,
        now: u64,
        period: &str,
        lines: &[PayLine],
        config: &Config,
    ) -> Result<SubmittedRun, Rejection> {
        let checked = self.check_run(now, period, lines, config)?;
        Ok(self.reserve(checked))
    }

    /// Checks 1–7 in SPEC order. Each numbered check finishes for every line before the next
    /// starts, and the error names the lowest failing index. `ERR_DUPLICATE_PAYEE` names the
    /// later line.
    fn check_run(
        &self,
        now: u64,
        period: &str,
        lines: &[PayLine],
        config: &Config,
    ) -> Result<CheckedRun, Rejection> {
        if lines.len() > usize::try_from(config.max_lines_per_run).expect("u32 fits in usize") {
            return Err(Rejection::new(ERR_TOO_MANY_LINES));
        }

        // R14: runs only for an open period. Text that is not canonical `YYYY-MM` is not open.
        let Some(period) = Period::parse(period).filter(|period| period.is_open_at(now)) else {
            return Err(Rejection::new(ERR_PERIOD_NOT_OPEN));
        };

        // R3: only active payees can be paid. A missing payee is not active.
        let mut caps = Vec::with_capacity(lines.len());
        for (index, line) in lines.iter().enumerate() {
            match self.payees.get(&line.account_id) {
                Some(payee) if now >= payee.active_from => caps.push(payee.cap),
                _ => {
                    return Err(Rejection::line(
                        ERR_PAYEE_NOT_ACTIVE,
                        index,
                        &line.account_id,
                    ));
                }
            }
        }

        // R4: wage <= wage cap.
        for (index, line) in lines.iter().enumerate() {
            if line.amount.0 > caps[index] {
                return Err(Rejection::line(ERR_ABOVE_WAGE_CAP, index, &line.account_id));
            }
        }

        // R5: each payee once per run. The later line is the duplicate.
        let mut seen = BTreeSet::new();
        for (index, line) in lines.iter().enumerate() {
            if !seen.insert(&line.account_id) {
                return Err(Rejection::line(
                    ERR_DUPLICATE_PAYEE,
                    index,
                    &line.account_id,
                ));
            }
        }

        // R5: each payee once per period, derived from line statuses.
        let period_key = period.to_string();
        let mut claimed = BTreeSet::new();
        for run_id in self.run_ids(&period_key) {
            let run = self
                .runs
                .get(run_id)
                .expect("period index points at a stored run");
            for account_id in run.claimants() {
                claimed.insert(account_id.clone());
            }
        }
        for (index, line) in lines.iter().enumerate() {
            if claimed.contains(&line.account_id) {
                return Err(Rejection::line(ERR_ALREADY_PAID, index, &line.account_id));
            }
        }

        // R6: treasury stays at or above the buffer. Overflow cannot fit in any treasury.
        let mut total = 0u128;
        for line in lines {
            let Some(sum) = total.checked_add(line.amount.0) else {
                return Err(Rejection::new(ERR_BELOW_BUFFER));
            };
            total = sum;
        }
        let Some(available) = self.treasury.checked_sub(self.buffer) else {
            return Err(Rejection::new(ERR_BELOW_BUFFER));
        };
        if total > available {
            return Err(Rejection::new(ERR_BELOW_BUFFER));
        }

        Ok(CheckedRun {
            period,
            lines: lines
                .iter()
                .map(|line| (line.account_id.clone(), line.amount.0))
                .collect(),
            total,
        })
    }

    /// Step 8. Infallible: `check_run` proved everything this uses, in the same call.
    fn reserve(&mut self, run: CheckedRun) -> SubmittedRun {
        // Check 7 proved `total <= treasury - buffer`, so this cannot underflow.
        self.treasury -= run.total;
        let period = run.period.to_string();
        let line_count = u32::try_from(run.lines.len()).expect("check 1 bounds the line count");
        let run_id = self.runs.len();
        self.runs.push(Run {
            period: period.clone(),
            lines: run
                .lines
                .into_iter()
                .map(|(account_id, amount)| RunLine {
                    account_id,
                    amount,
                    status: LineStatus::Reserved,
                })
                .collect(),
        });
        let mut ids = self.run_ids(&period);
        ids.push(run_id);
        self.runs_by_period.insert(period.clone(), ids);
        self.onboarding = false;
        SubmittedRun {
            run_id: u64::from(run_id),
            period,
            total: run.total,
            line_count,
        }
    }

    fn run_ids(&self, period: &str) -> Vec<u32> {
        self.runs_by_period.get(period).cloned().unwrap_or_default()
    }

    pub(crate) fn view(&self) -> EmployerView {
        EmployerView {
            treasury: U128(self.treasury),
            buffer: U128(self.buffer),
            onboarding: self.onboarding,
            payee_count: self.payees.len(),
        }
    }

    /// Looks up `period` as stored. Keys are canonical, so other text finds nothing.
    pub(crate) fn runs_in(&self, period: &str) -> Vec<RunView> {
        self.run_ids(period)
            .into_iter()
            .map(|run_id| {
                let run = self
                    .runs
                    .get(run_id)
                    .expect("period index points at a stored run");
                RunView::of(u64::from(run_id), run)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use near_sdk::json_types::U128;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{AccountId, testing_env};

    use super::Employer;
    use crate::config::Config;
    use crate::run::{LineStatus, PayLine, RunStatus};

    const W1: &str = "w-7k2q9x.homeroll.testnet";
    const STRANGER: &str = "w-miss01.homeroll.testnet";
    /// 2026-11-15 00:00:00 UTC, so "2026-11" is the open period.
    const NOW: u64 = 1_794_700_800_000_000_000;

    fn account(text: &str) -> AccountId {
        text.parse().expect("account id")
    }

    fn line(account_id: &str, amount: u128) -> PayLine {
        PayLine {
            account_id: account(account_id),
            amount: U128(amount),
        }
    }

    fn employer_with_one_payee() -> Employer {
        testing_env!(VMContextBuilder::new().build());
        let mut employer = Employer::new(&account("perabotjaya.homeroll.testnet"), 0);
        employer
            .add_payee(account(W1), 100, NOW, &Config::INITIAL)
            .expect("onboarding add");
        employer
    }

    #[test]
    fn the_wage_cap_error_names_the_line_exactly() {
        let mut employer = employer_with_one_payee();
        let err = employer
            .submit_run(NOW, "2026-11", &[line(W1, 101)], &Config::INITIAL)
            .unwrap_err();
        assert_eq!(
            err.as_str(),
            "ERR_ABOVE_WAGE_CAP:0:w-7k2q9x.homeroll.testnet"
        );
        assert!(employer.runs_in("2026-11").is_empty());
        assert!(employer.onboarding);
        assert_eq!(employer.treasury, 0);
    }

    /// Line 0 is above its cap (check 4). Line 1 is not a payee (check 3). Check 3 wins.
    #[test]
    fn payee_check_runs_before_wage_cap_across_lines() {
        let mut employer = employer_with_one_payee();
        let err = employer
            .submit_run(
                NOW,
                "2026-11",
                &[line(W1, 101), line(STRANGER, 1)],
                &Config::INITIAL,
            )
            .unwrap_err();
        assert_eq!(err.as_str(), format!("ERR_PAYEE_NOT_ACTIVE:1:{STRANGER}"));
        assert!(employer.runs_in("2026-11").is_empty());
    }

    #[test]
    fn a_checked_run_reserves_its_total_and_ends_onboarding() {
        let mut employer = employer_with_one_payee();
        // No credit method in this unit, so the test funds the treasury directly.
        employer.treasury = 1_000;
        let submitted = employer
            .submit_run(NOW, "2026-11", &[line(W1, 100)], &Config::INITIAL)
            .expect("funded run");
        assert_eq!(submitted.run_id, 0);
        assert_eq!(submitted.total, 100);
        assert_eq!(employer.treasury, 900);
        assert!(!employer.onboarding);
        let runs = employer.runs_in("2026-11");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, 0);
        assert_eq!(runs[0].status, RunStatus::Pending);
        assert_eq!(runs[0].lines.len(), 1);
        assert_eq!(runs[0].lines[0].account_id, account(W1));
        assert_eq!(runs[0].lines[0].amount, U128(100));
        assert_eq!(runs[0].lines[0].status, LineStatus::Reserved);
    }

    #[test]
    fn the_same_run_submitted_twice_is_already_paid() {
        let mut employer = employer_with_one_payee();
        employer.treasury = 100;
        employer
            .submit_run(NOW, "2026-11", &[line(W1, 100)], &Config::INITIAL)
            .expect("first run");
        let err = employer
            .submit_run(NOW, "2026-11", &[line(W1, 100)], &Config::INITIAL)
            .unwrap_err();
        assert_eq!(err.as_str(), format!("ERR_ALREADY_PAID:0:{W1}"));
        assert_eq!(employer.treasury, 0);
        assert_eq!(employer.runs_in("2026-11").len(), 1);
    }
}
