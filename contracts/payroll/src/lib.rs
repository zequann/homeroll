//! Payroll at `payroll.<root>` (SPEC §7.3): employer treasuries, payees with wage caps,
//! and payroll runs that are checked whole, then paid in batches (ADR-0001).

use near_sdk::{AccountId, PanicOnDefault, near};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Payroll {
    /// The Homeroll admin (SPEC §7, common rules).
    admin: AccountId,
}

#[near]
impl Payroll {
    #[init]
    pub fn new(admin: AccountId) -> Self {
        Self { admin }
    }
}
