//! Pool at `pool.<root>` (SPEC §7.4): lender pool, invoice registry and invoice advances.

use near_sdk::{AccountId, PanicOnDefault, near};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pool {
    /// The Homeroll admin (SPEC §7, common rules).
    admin: AccountId,
}

#[near]
impl Pool {
    #[init]
    pub fn new(admin: AccountId) -> Self {
        Self { admin }
    }
}
