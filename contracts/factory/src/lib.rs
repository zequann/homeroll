//! Factory at `<root>` (SPEC §7.2): creates pseudonymous worker accounts `w-xxxxxx.<root>`,
//! funds them for storage, and registers them on the token so payroll can pay them.

use homeroll_common::errors::{
    ERR_ACCOUNT_EXISTS, ERR_INVALID_NAME, ERR_NOT_ADMIN, ERR_TOKEN_REGISTRATION_FAILED,
};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PublicKey, env, ext_contract,
    is_promise_success, near, require,
};

/// NEAR each new worker account gets for its own storage (SPEC §7.2).
const WORKER_FUNDING: NearToken = NearToken::from_millinear(50);
/// Attached to `storage_deposit`. The reference token needs 0.00125 NEAR; it refunds
/// the rest to the factory, so the margin only guards against a changed storage price.
const TOKEN_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(10);

const GAS_FOR_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
const GAS_FOR_ON_WORKER_REGISTERED: Gas = Gas::from_tgas(5);
/// Covers `on_account_created` itself plus the two calls it schedules.
const GAS_FOR_ON_ACCOUNT_CREATED: Gas = Gas::from_tgas(25);

#[ext_contract(ext_token)]
#[allow(dead_code, reason = "only the generated `ext_token` is used")]
trait TokenStorage {
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    /// The Homeroll admin (SPEC §7, common rules).
    admin: AccountId,
    /// Token that workers are registered on: `tusdc.<root>` (SPEC §7.1).
    token: AccountId,
}

#[near]
impl Factory {
    #[init]
    pub fn new(admin: AccountId, token: AccountId) -> Self {
        Self { admin, token }
    }

    /// Creates `{name}.<root>` with `public_key` as its full-access key, funds it, then
    /// registers it on the token. Resolves to the new account ID once it can be paid.
    /// The steps are asynchronous and NEAR does not roll back a created account, so each
    /// failure is reported with its own error code.
    pub fn create_worker(&mut self, name: String, public_key: PublicKey) -> Promise {
        // SPEC §7.2: only the admin, because every account costs the factory NEAR.
        require!(env::predecessor_account_id() == self.admin, ERR_NOT_ADMIN);
        // R13: a random pseudonymous name, never one derived from a real name.
        require!(is_worker_name(&name), ERR_INVALID_NAME);
        let account_id: AccountId = format!("{name}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str(ERR_INVALID_NAME));

        Promise::new(account_id.clone())
            .create_account()
            .transfer(WORKER_FUNDING)
            .add_full_access_key(public_key)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_ACCOUNT_CREATED)
                    .on_account_created(account_id),
            )
    }

    #[private]
    pub fn on_account_created(&mut self, account_id: AccountId) -> Promise {
        // A failed create (the name is taken) returns the 0.05 NEAR to the factory.
        require!(is_promise_success(), ERR_ACCOUNT_EXISTS);
        ext_token::ext(self.token.clone())
            .with_attached_deposit(TOKEN_STORAGE_DEPOSIT)
            .with_static_gas(GAS_FOR_STORAGE_DEPOSIT)
            .storage_deposit(Some(account_id.clone()), Some(true))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_WORKER_REGISTERED)
                    .on_worker_registered(account_id),
            )
    }

    #[private]
    pub fn on_worker_registered(&mut self, account_id: AccountId) -> AccountId {
        // The account exists but cannot hold tokens: only a misconfigured token does this.
        require!(is_promise_success(), ERR_TOKEN_REGISTRATION_FAILED);
        account_id
    }
}

/// `^w-[a-z0-9]{6}$` (SPEC §7.2), checked without a regex crate to keep the wasm small.
fn is_worker_name(name: &str) -> bool {
    name.len() == 8
        && name.starts_with("w-")
        && name
            .bytes()
            .skip(2)
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::testing_env;

    fn factory_called_by(caller: AccountId) -> Factory {
        let factory = Factory::new(accounts(0), accounts(1));
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(caller)
                .build()
        );
        factory
    }

    fn worker_key() -> PublicKey {
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
            .parse()
            .unwrap()
    }

    #[test]
    fn accepts_only_random_pseudonymous_names() {
        for name in ["w-7k2q9x", "w-000000", "w-zzzzzz"] {
            assert!(is_worker_name(name), "{name} should be accepted");
        }
        for name in [
            "rahim",
            "w-7k2q9",
            "w-7k2q9x1",
            "w-7K2Q9X",
            "w_7k2q9x",
            "x-7k2q9x",
            "w-7k2q9!",
            "w-7k.q9x",
            "",
        ] {
            assert!(!is_worker_name(name), "{name} should be rejected");
        }
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_ADMIN")]
    fn only_the_admin_creates_workers() {
        let _ = factory_called_by(accounts(2)).create_worker("w-7k2q9x".to_owned(), worker_key());
    }

    #[test]
    #[should_panic(expected = "ERR_INVALID_NAME")]
    fn a_real_name_is_rejected() {
        let _ = factory_called_by(accounts(0)).create_worker("rahim".to_owned(), worker_key());
    }
}
