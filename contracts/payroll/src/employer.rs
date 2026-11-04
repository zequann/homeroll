use std::collections::BTreeSet;

use homeroll_common::errors::{
    ERR_ABOVE_WAGE_CAP, ERR_ALREADY_PAID, ERR_BELOW_BUFFER, ERR_DUPLICATE_PAYEE,
    ERR_PAYEE_NOT_ACTIVE, ERR_PERIOD_NOT_OPEN, ERR_RUN_COMPLETE, ERR_RUN_NOT_FOUND,
    ERR_TOO_MANY_LINES, ERR_TOO_MANY_PAYEES,
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

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PayAction {
    Sent {
        index: u32,
        account_id: AccountId,
        amount: u128,
    },
    Skipped {
        index: u32,
        account_id: AccountId,
        amount: u128,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Settlement {
    Paid,
    Failed { account_id: AccountId, amount: u128 },
    Ignored,
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
            if Self::payee_active(&self.payees, &line.account_id, now) {
                caps.push(
                    self.payees
                        .get(&line.account_id)
                        .expect("active implies present")
                        .cap,
                );
            } else {
                return Err(Rejection::line(
                    ERR_PAYEE_NOT_ACTIVE,
                    index,
                    &line.account_id,
                ));
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

    fn payee_active(
        payees: &IterableMap<AccountId, Payee>,
        account_id: &AccountId,
        now: u64,
    ) -> bool {
        payees
            .get(account_id)
            .is_some_and(|payee| now >= payee.active_from)
    }

    /// Pays up to `max_lines_per_call` reserved lines. Inactive payees are skipped (R3).
    pub(crate) fn pay_run(
        &mut self,
        run_id: u64,
        now: u64,
        config: &Config,
    ) -> Result<Vec<PayAction>, Rejection> {
        let run_id_u32 = u32::try_from(run_id)
            .ok()
            .filter(|&id| id < self.runs.len());
        let Some(run_id_u32) = run_id_u32 else {
            return Err(Rejection::new(ERR_RUN_NOT_FOUND));
        };
        let has_reserved = self.runs.get(run_id_u32).is_some_and(|run| {
            run.lines
                .iter()
                .any(|line| matches!(line.status, LineStatus::Reserved))
        });
        if !has_reserved {
            return Err(Rejection::new(ERR_RUN_COMPLETE));
        }

        let mut actions = Vec::new();
        let mut batch = 0u32;
        let run = self
            .runs
            .get_mut(run_id_u32)
            .expect("run id was validated above");
        for (index, line) in run.lines.iter_mut().enumerate() {
            if batch >= config.max_lines_per_call {
                break;
            }
            if !matches!(line.status, LineStatus::Reserved) {
                continue;
            }
            batch += 1;
            let account_id = line.account_id.clone();
            let amount = line.amount;
            if Self::payee_active(&self.payees, &account_id, now) {
                line.status = LineStatus::Sent;
                actions.push(PayAction::Sent {
                    index: u32::try_from(index).expect("line index fits in u32"),
                    account_id,
                    amount,
                });
            } else {
                // R3: an inactive payee is skipped and the amount returns to treasury.
                line.status = LineStatus::Skipped;
                self.treasury = self
                    .treasury
                    .checked_add(amount)
                    .expect("treasury refund cannot overflow");
                actions.push(PayAction::Skipped {
                    index: u32::try_from(index).expect("line index fits in u32"),
                    account_id,
                    amount,
                });
            }
        }
        Ok(actions)
    }

    pub(crate) fn settle_line(
        &mut self,
        run_id: u64,
        line_index: u32,
        transfer_ok: bool,
    ) -> Settlement {
        let Ok(run_id_u32) = u32::try_from(run_id) else {
            return Settlement::Ignored;
        };
        let Some(run) = self.runs.get_mut(run_id_u32) else {
            return Settlement::Ignored;
        };
        let Some(line) = run.lines.get_mut(line_index as usize) else {
            return Settlement::Ignored;
        };
        if !matches!(line.status, LineStatus::Sent) {
            return Settlement::Ignored;
        }
        if transfer_ok {
            line.status = LineStatus::Paid;
            Settlement::Paid
        } else {
            line.status = LineStatus::Failed;
            self.treasury = self
                .treasury
                .checked_add(line.amount)
                .expect("treasury refund cannot overflow");
            Settlement::Failed {
                account_id: line.account_id.clone(),
                amount: line.amount,
            }
        }
    }

    pub(crate) fn credit_treasury(&mut self, amount: u128) -> bool {
        match self.treasury.checked_add(amount) {
            Some(treasury) => {
                self.treasury = treasury;
                true
            }
            None => false,
        }
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
    use super::{PayAction, Settlement};
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

    fn config_one_line_per_call() -> Config {
        Config {
            max_lines_per_run: 40,
            max_lines_per_call: 1,
            max_payees_per_employer: 40,
            hold_ns: Config::INITIAL.hold_ns,
        }
    }

    const W2: &str = "w-abc123.homeroll.testnet";

    fn employer_with_two_payees() -> Employer {
        let mut employer = employer_with_one_payee();
        employer
            .add_payee(account(W2), 100, NOW, &Config::INITIAL)
            .expect("second payee");
        employer.treasury = 200;
        employer
    }

    #[test]
    fn pay_run_sends_one_line_per_call_and_leaves_the_run_pending() {
        let mut employer = employer_with_two_payees();
        employer
            .submit_run(
                NOW,
                "2026-11",
                &[line(W1, 100), line(W2, 100)],
                &Config::INITIAL,
            )
            .expect("submit");
        assert_eq!(employer.treasury, 0);
        let actions = employer
            .pay_run(0, NOW, &config_one_line_per_call())
            .expect("first batch");
        assert_eq!(actions.len(), 1);
        assert!(matches!(actions[0], PayAction::Sent { index: 0, .. }));
        let runs = employer.runs_in("2026-11");
        assert_eq!(runs[0].status, RunStatus::Pending);
        assert_eq!(runs[0].lines[0].status, LineStatus::Sent);
        assert_eq!(runs[0].lines[1].status, LineStatus::Reserved);
    }

    #[test]
    fn the_second_pay_run_sends_the_next_reserved_line_only() {
        let mut employer = employer_with_two_payees();
        employer
            .submit_run(
                NOW,
                "2026-11",
                &[line(W1, 100), line(W2, 100)],
                &Config::INITIAL,
            )
            .expect("submit");
        employer
            .pay_run(0, NOW, &config_one_line_per_call())
            .expect("first batch");
        let actions = employer
            .pay_run(0, NOW, &config_one_line_per_call())
            .expect("second batch");
        assert_eq!(actions.len(), 1);
        assert!(matches!(actions[0], PayAction::Sent { index: 1, .. }));
        let runs = employer.runs_in("2026-11");
        assert_eq!(runs[0].lines[0].status, LineStatus::Sent);
        assert_eq!(runs[0].lines[1].status, LineStatus::Sent);
    }

    #[test]
    fn a_second_settlement_on_a_finished_line_is_ignored() {
        let mut employer = employer_with_one_payee();
        employer.treasury = 100;
        employer
            .submit_run(NOW, "2026-11", &[line(W1, 100)], &Config::INITIAL)
            .expect("submit");
        employer
            .pay_run(0, NOW, &config_one_line_per_call())
            .expect("send");
        assert_eq!(
            employer.settle_line(0, 0, true),
            Settlement::Paid,
            "first callback"
        );
        assert_eq!(employer.treasury, 0);
        assert_eq!(employer.settle_line(0, 0, true), Settlement::Ignored);
        assert_eq!(employer.treasury, 0);

        let mut employer = employer_with_one_payee();
        employer.treasury = 100;
        employer
            .submit_run(NOW, "2026-11", &[line(W1, 100)], &Config::INITIAL)
            .expect("submit");
        employer
            .pay_run(0, NOW, &config_one_line_per_call())
            .expect("send");
        assert_eq!(
            employer.settle_line(0, 0, false),
            Settlement::Failed {
                account_id: account(W1),
                amount: 100,
            }
        );
        assert_eq!(employer.treasury, 100);
        assert_eq!(employer.settle_line(0, 0, false), Settlement::Ignored);
        assert_eq!(employer.treasury, 100);
    }

    #[test]
    fn a_sent_line_still_holds_the_period() {
        let mut employer = employer_with_one_payee();
        employer.treasury = 100;
        employer
            .submit_run(NOW, "2026-11", &[line(W1, 100)], &Config::INITIAL)
            .expect("submit");
        employer
            .pay_run(0, NOW, &config_one_line_per_call())
            .expect("send");
        let err = employer
            .submit_run(NOW, "2026-11", &[line(W1, 100)], &Config::INITIAL)
            .unwrap_err();
        assert_eq!(err.as_str(), format!("ERR_ALREADY_PAID:0:{W1}"));
    }

    #[test]
    fn a_failed_line_does_not_hold_the_period() {
        let mut employer = employer_with_one_payee();
        employer.treasury = 200;
        employer
            .submit_run(NOW, "2026-11", &[line(W1, 100)], &Config::INITIAL)
            .expect("first submit");
        employer
            .pay_run(0, NOW, &config_one_line_per_call())
            .expect("send");
        assert_eq!(
            employer.settle_line(0, 0, false),
            Settlement::Failed {
                account_id: account(W1),
                amount: 100,
            }
        );
        employer
            .submit_run(NOW, "2026-11", &[line(W1, 50)], &Config::INITIAL)
            .expect("retry after failure");
        assert_eq!(employer.treasury, 150);
    }
}
