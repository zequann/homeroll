//! Payroll at `payroll.<root>` (SPEC §7.3): employer treasuries, payees with wage caps,
//! and payroll runs that are checked whole, then paid in batches (ADR-0001).

mod config;
mod employer;
mod events;
mod run;

use homeroll_common::errors::{ERR_EMPLOYER_EXISTS, ERR_NOT_ADMIN, ERR_NOT_EMPLOYER, line_error};
use near_sdk::json_types::{U64, U128};
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require};

use config::Config;
use employer::{Employer, EmployerView};
use events::{EmployerRegistered, PayeeAdded, PayrollEvent, RunSubmitted};
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

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Payroll {
    /// The Homeroll admin (SPEC §7, common rules).
    admin: AccountId,
    config: Config,
    employers: LookupMap<AccountId, Employer>,
}

#[near]
impl Payroll {
    /// Unchanged interface.
    #[init]
    pub fn new(admin: AccountId) -> Self {
        Self {
            admin,
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

    /// `null` for an unknown employer.
    pub fn get_employer(&self, employer: AccountId) -> Option<EmployerView> {
        self.employers.get(&employer).map(Employer::view)
    }

    /// Runs for `period`, oldest first. `null` for an unknown employer.
    /// `[]` when the employer has none, including when `period` is not canonical `YYYY-MM`.
    pub fn get_runs(&self, employer: AccountId, period: String) -> Option<Vec<RunView>> {
        self.employers
            .get(&employer)
            .map(|record| record.runs_in(&period))
    }

    fn employer_mut(&mut self, account_id: &AccountId) -> &mut Employer {
        match self.employers.get_mut(account_id) {
            Some(employer) => employer,
            None => env::panic_str(ERR_NOT_EMPLOYER),
        }
    }
}
