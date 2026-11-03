//! Test USDC (SPEC §7.1): NEP-141 + NEP-145 + NEP-148, `symbol: "tUSDC"`, 6 decimals.
//! Everything except `mint` is the reference fungible token from near-contract-standards,
//! wired up by hand as its deprecated macros advise. Mintable by the Homeroll admin, on
//! testnet only: real USDC has no such method.

use homeroll_common::errors::ERR_NOT_ADMIN;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue, env, near, require,
};

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Accounts,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Tusdc {
    /// The Homeroll admin (SPEC §7, common rules).
    admin: AccountId,
    token: FungibleToken,
}

#[near]
impl Tusdc {
    #[init]
    pub fn new(admin: AccountId) -> Self {
        Self {
            admin,
            token: FungibleToken::new(StorageKey::Accounts),
        }
    }

    /// Creates `amount` tUSDC (base units) for an account already registered for storage.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        // SPEC §7.1: only the admin creates money.
        require!(env::predecessor_account_id() == self.admin, ERR_NOT_ADMIN);
        self.token.internal_deposit(&account_id, amount.0);
        FtMint {
            owner_id: &account_id,
            amount,
            memo: None,
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for Tusdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Tusdc {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        // The reference resolver emits FtBurn itself if the sender closed their account.
        let (used_amount, _burned_amount) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Tusdc {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        let Some((account_id, balance)) = self.token.internal_storage_unregister(force) else {
            return false;
        };
        // A forced unregister burns the remaining balance; NEP-141 requires the event.
        if balance > 0 {
            FtBurn {
                owner_id: &account_id,
                amount: balance.into(),
                memo: Some("storage unregistered"),
            }
            .emit();
        }
        true
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Tusdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_owned(),
            name: "Test USDC".to_owned(),
            symbol: "tUSDC".to_owned(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::testing_env;

    fn admin() -> AccountId {
        accounts(0)
    }

    fn holder() -> AccountId {
        accounts(1)
    }

    /// A fresh token with `holder()` registered, and the next call made by `caller`.
    fn tusdc_called_by(caller: AccountId) -> Tusdc {
        let mut tusdc = Tusdc::new(admin());
        tusdc.token.internal_register_account(&holder());
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(caller)
                .build()
        );
        tusdc
    }

    #[test]
    fn admin_mints_to_a_registered_account() {
        let mut tusdc = tusdc_called_by(admin());
        tusdc.mint(holder(), U128(1_950_000_000));
        assert_eq!(tusdc.ft_balance_of(holder()), U128(1_950_000_000));
        assert_eq!(tusdc.ft_total_supply(), U128(1_950_000_000));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_ADMIN")]
    fn anyone_else_cannot_mint() {
        let mut tusdc = tusdc_called_by(holder());
        tusdc.mint(holder(), U128(1));
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn minting_to_an_unregistered_account_fails() {
        let mut tusdc = tusdc_called_by(admin());
        tusdc.mint(accounts(2), U128(1));
    }

    #[test]
    fn metadata_is_test_usdc_with_six_decimals() {
        let metadata = tusdc_called_by(admin()).ft_metadata();
        assert_eq!(metadata.symbol, "tUSDC");
        assert_eq!(metadata.name, "Test USDC");
        assert_eq!(metadata.decimals, 6);
    }
}
