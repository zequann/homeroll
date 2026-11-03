use near_sdk::json_types::U128;
use near_sdk::{AccountId, near};

/// One pay line as callers send it (SPEC §7.3). Wire type: converted to `(AccountId, u128)`
/// inside `Employer::check_run`, never stored.
#[near(serializers = [json])]
pub struct PayLine {
    pub account_id: AccountId,
    pub amount: U128,
}

/// A stored payroll run. Run id is its index in `Employer::runs`.
/// No `status` field and no `next` field: both come from `lines`.
#[near(serializers = [borsh])]
pub(crate) struct Run {
    /// Canonical `YYYY-MM`, written from `Period`, never from raw input.
    pub(crate) period: String,
    pub(crate) lines: Vec<RunLine>,
}

#[near(serializers = [borsh])]
pub(crate) struct RunLine {
    pub(crate) account_id: AccountId,
    pub(crate) amount: u128,
    pub(crate) status: LineStatus,
}

/// Only the states this unit can produce. Later units append variants so borsh tags stay stable.
/// Every `match` is exhaustive, with no `_` arm.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineStatus {
    Reserved,
}

impl LineStatus {
    /// SPEC §7.3 paid: a line holds its period when it is not failed, skipped, or cancelled.
    /// Check 6 reads this and nothing else.
    pub(crate) const fn claims_period(self) -> bool {
        match self {
            Self::Reserved => true,
        }
    }
}

/// Derived, never stored.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunStatus {
    Pending,
    Done,
}

impl Run {
    /// Pending while any line is Reserved, otherwise Done.
    pub(crate) fn status(&self) -> RunStatus {
        if self
            .lines
            .iter()
            .any(|line| matches!(line.status, LineStatus::Reserved))
        {
            RunStatus::Pending
        } else {
            RunStatus::Done
        }
    }

    /// Accounts this run holds the period for.
    pub(crate) fn claimants(&self) -> impl Iterator<Item = &AccountId> {
        self.lines
            .iter()
            .filter_map(|line| line.status.claims_period().then_some(&line.account_id))
    }
}

/// `get_runs` element. Built only by `RunView::of`.
#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct RunView {
    pub run_id: u64,
    pub period: String,
    pub status: RunStatus,
    pub lines: Vec<RunLineView>,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq, Eq)]
pub struct RunLineView {
    pub account_id: AccountId,
    pub amount: U128,
    pub status: LineStatus,
}

impl RunView {
    pub(crate) fn of(run_id: u64, run: &Run) -> Self {
        Self {
            run_id,
            period: run.period.clone(),
            status: run.status(),
            lines: run
                .lines
                .iter()
                .map(|line| RunLineView {
                    account_id: line.account_id.clone(),
                    amount: U128(line.amount),
                    status: line.status,
                })
                .collect(),
        }
    }
}
