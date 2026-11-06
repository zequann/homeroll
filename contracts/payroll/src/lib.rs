//! Payroll at `payroll.<root>` (SPEC §7.3): employer treasuries, payees with wage caps,
//! and payroll runs that are checked whole, then paid in batches (ADR-0001).

mod config;
mod employer;
mod events;
mod run;

use homeroll_common::errors::{ERR_EMPLOYER_EXISTS, ERR_NOT_ADMIN, ERR_NOT_EMPLOYER, line_error};
use near_sdk::json_types::{U64, U128};
use near_sdk::store::LookupMap;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseError, PromiseOrValue, env,
    ext_contract, near, require,
};

use config::Config;
use employer::{Employer, EmployerView, PayAction, PayeeView, Settlement};
use events::{
    EmployerRegistered, PayeeAdded, PayeeRemoved, PayrollEvent, PayrollLineEvent, RunCancelled,
    RunSubmitted,
};
use run::{PayLine, RunView};

/// One enum for every storage prefix, so two collections cannot share a key space.
#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub(crate) enum StorageKey {
    Employers,
    Payees { employer: AccountId },
    Runs { employer: AccountId },
    RunsByPeriod { employer: AccountId },
}

/// A rejected call. The panic string is built only from `homeroll_common::errors`.
#[derive(Debug)]
pub(crate) struct Rejection(String);

impl Rejection {
    pub(crate) fn new(code: &'static str) -> Self {
        Self(code.to_owned())
    }

    /// `<code>:<index>:<account>`, 0-based (SPEC §7.3).
    pub(crate) fn line(code: &'static str, index: usize, account_id: &AccountId) -> Self {
        Self(line_error(code, index, account_id.as_str()))
    }

    pub(crate) fn panic(self) -> ! {
        env::panic_str(&self.0)
    }

    /// Unit tests compare the panic string as a value. The contract itself only panics.
    #[cfg(test)]
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_ON_LINE_PAID: Gas = Gas::from_tgas(10);

#[ext_contract(ext_ft)]
#[allow(dead_code, reason = "only the generated `ext_ft` is used")]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

fn employer_from_credit_msg(msg: &str) -> Option<AccountId> {
    let value: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(msg).ok()?;
    let employer = value.get("employer")?.as_str()?;
    employer.parse().ok()
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Payroll {
    /// The Homeroll admin (SPEC §7, common rules).
    admin: AccountId,
    /// tUSDC account (`tusdc.<root>`). Set at init, never updated.
    token: AccountId,
    config: Config,
    employers: LookupMap<AccountId, Employer>,
}

#[near]
impl Payroll {
    #[init]
    pub fn new(admin: AccountId, token: AccountId) -> Self {
        Self {
            admin,
            token,
            config: Config::INITIAL,
            employers: LookupMap::new(StorageKey::Employers),
        }
    }

    /// Admin onboards an employer with `onboarding = true` (SPEC §7.3, ADR-0002).
    pub fn register_employer(&mut self, employer: AccountId, buffer: U128) {
        // R15: only the Homeroll admin onboards employers.
        require!(env::predecessor_account_id() == self.admin, ERR_NOT_ADMIN);
        require!(!self.employers.contains_key(&employer), ERR_EMPLOYER_EXISTS);
        let buffer = buffer.0;
        self.employers
            .insert(employer.clone(), Employer::new(&employer, buffer));
        let registered = [EmployerRegistered {
            employer: employer.clone(),
            buffer: U128(buffer),
        }];
        PayrollEvent::EmployerRegistered(&registered).emit();
    }

    /// Employer adds or replaces a payee and a wage cap.
    pub fn add_payee(&mut self, account_id: AccountId, cap: U128) {
        let caller = env::predecessor_account_id();
        let config = self.config;
        let now = env::block_timestamp();
        let added = {
            let employer = self.employer_mut(&caller);
            match employer.add_payee(account_id.clone(), cap.0, now, &config) {
                Ok(payee) => payee,
                Err(rejection) => rejection.panic(),
            }
        };
        let added_event = [PayeeAdded {
            employer: caller,
            account_id,
            cap,
            active_from: U64(added.active_from),
        }];
        PayrollEvent::PayeeAdded(&added_event).emit();
    }

    /// Employer removes a payee at once. Their lines not yet sent are skipped by `pay_run` (R3).
    /// Not on the payroll agent's key, so only the owner's key reaches it (SPEC §6).
    pub fn remove_payee(&mut self, account_id: AccountId) {
        let caller = env::predecessor_account_id();
        if let Err(rejection) = self.employer_mut(&caller).remove_payee(&account_id) {
            rejection.panic();
        }
        let event = [PayeeRemoved {
            employer: caller,
            account_id,
        }];
        PayrollEvent::PayeeRemoved(&event).emit();
    }

    /// Cancels every line not yet sent and returns its money to the treasury (SPEC §7.3).
    /// Not on the payroll agent's key, so only the owner's key reaches it (SPEC §6).
    pub fn cancel_run(&mut self, run_id: u64) {
        let caller = env::predecessor_account_id();
        let cancelled = match self.employer_mut(&caller).cancel_run(run_id) {
            Ok(cancelled) => cancelled,
            Err(rejection) => rejection.panic(),
        };
        let event = [RunCancelled {
            employer: caller,
            run_id,
            amount: U128(cancelled.returned),
            line_count: cancelled.line_count,
        }];
        PayrollEvent::RunCancelled(&event).emit();
    }

    /// Checks the whole run and reserves its total. Returns the run id (SPEC §7.3, ADR-0001).
    pub fn submit_run(&mut self, period: String, lines: Vec<PayLine>) -> u64 {
        // A caller that is not an employer is rejected before check 1.
        let caller = env::predecessor_account_id();
        let config = self.config;
        let now = env::block_timestamp();
        let submitted = {
            let employer = self.employer_mut(&caller);
            match employer.submit_run(now, &period, &lines, &config) {
                Ok(submitted) => submitted,
                Err(rejection) => rejection.panic(),
            }
        };
        let submitted_event = [RunSubmitted {
            employer: caller,
            run_id: submitted.run_id,
            period: &submitted.period,
            total: U128(submitted.total),
            line_count: submitted.line_count,
        }];
        PayrollEvent::RunSubmitted(&submitted_event).emit();
        submitted.run_id
    }

    /// Sends or skips up to `max_lines_per_call` reserved lines (SPEC §7.3).
    pub fn pay_run(&mut self, run_id: u64) {
        let caller = env::predecessor_account_id();
        let mut config = self.config;
        // A wasm swap does not rewrite the config stored by `new`.
        config.max_lines_per_call = Config::lines_per_call();
        let now = env::block_timestamp();
        let token = self.token.clone();
        let actions = {
            let employer = self.employer_mut(&caller);
            match employer.pay_run(run_id, now, &config) {
                Ok(actions) => actions,
                Err(rejection) => rejection.panic(),
            }
        };

        for action in actions {
            match action {
                PayAction::Skipped {
                    index,
                    account_id,
                    amount,
                } => {
                    let event = [PayrollLineEvent {
                        employer: caller.clone(),
                        run_id,
                        line_index: index,
                        account_id,
                        amount: U128(amount),
                    }];
                    PayrollEvent::PayrollLineSkipped(&event).emit();
                }
                PayAction::Sent {
                    index,
                    account_id,
                    amount,
                } => {
                    let event = [PayrollLineEvent {
                        employer: caller.clone(),
                        run_id,
                        line_index: index,
                        account_id: account_id.clone(),
                        amount: U128(amount),
                    }];
                    PayrollEvent::PayrollLineSent(&event).emit();
                    // Each transfer is its own chain. `then` panics if a callback already
                    // has a predecessor, so a second line cannot be attached to the first.
                    ext_ft::ext(token.clone())
                        .with_attached_deposit(ONE_YOCTO)
                        .with_static_gas(GAS_FOR_FT_TRANSFER)
                        .ft_transfer(account_id, U128(amount), None)
                        .then(
                            Self::ext(env::current_account_id())
                                .with_static_gas(GAS_FOR_ON_LINE_PAID)
                                .on_line_paid(caller.clone(), run_id, index),
                        )
                        .detach();
                }
            }
        }
    }

    #[private]
    pub fn on_line_paid(
        &mut self,
        employer: AccountId,
        run_id: u64,
        line_index: u32,
        #[callback_result] transfer: Result<(), PromiseError>,
    ) {
        let settlement = match self.employers.get_mut(&employer) {
            Some(record) => record.settle_line(run_id, line_index, transfer.is_ok()),
            None => Settlement::Ignored,
        };
        if let Settlement::Failed { account_id, amount } = settlement {
            let event = [PayrollLineEvent {
                employer,
                run_id,
                line_index,
                account_id,
                amount: U128(amount),
            }];
            PayrollEvent::PayrollLineFailed(&event).emit();
        }
    }

    #[payable]
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = sender_id;
        if env::predecessor_account_id() != self.token {
            return PromiseOrValue::Value(amount);
        }
        let Some(employer_id) = employer_from_credit_msg(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        let Some(record) = self.employers.get_mut(&employer_id) else {
            return PromiseOrValue::Value(amount);
        };
        if record.credit_treasury(amount.0) {
            PromiseOrValue::Value(U128(0))
        } else {
            PromiseOrValue::Value(amount)
        }
    }

    /// `null` for an unknown employer.
    pub fn get_employer(&self, employer: AccountId) -> Option<EmployerView> {
        self.employers.get(&employer).map(Employer::view)
    }

    /// Payees of `employer`. `null` for an unknown employer.
    pub fn get_payees(&self, employer: AccountId) -> Option<Vec<PayeeView>> {
        self.employers.get(&employer).map(Employer::payee_views)
    }

    /// Runs for `period`, oldest first. `null` for an unknown employer.
    /// `[]` when the employer has none, including when `period` is not canonical `YYYY-MM`.
    pub fn get_runs(&self, employer: AccountId, period: String) -> Option<Vec<RunView>> {
        self.employers
            .get(&employer)
            .map(|record| record.runs_in(&period))
    }

    /// One run by id. `null` for an unknown employer or run id.
    pub fn get_run(&self, employer: AccountId, run_id: u64) -> Option<RunView> {
        self.employers
            .get(&employer)
            .and_then(|record| record.run_view(run_id))
    }

    fn employer_mut(&mut self, account_id: &AccountId) -> &mut Employer {
        match self.employers.get_mut(account_id) {
            Some(employer) => employer,
            None => env::panic_str(ERR_NOT_EMPLOYER),
        }
    }
}
