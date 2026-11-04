//! Pool at `pool.<root>` (SPEC §7.4): lender pool, invoice registry and invoice advances.

#![allow(
    clippy::too_many_arguments,
    reason = "attest_invoice takes the SPEC §7.4 argument list"
)]

mod books;
mod events;

use homeroll_common::errors::{
    ERR_DEPOSIT_TOO_SMALL, ERR_NOT_ADMIN, ERR_NOT_AGENT, ERR_NOT_SETTLER,
};
use near_sdk::json_types::{U64, U128};
use near_sdk::store::LookupSet;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseError, PromiseOrValue, env,
    ext_contract, near, require,
};

use books::{
    AdvanceResolution, Books, BuyerHash, Grade, Header, InvoiceHash, LenderView, PoolMsg, PoolView,
    SettleAttempt, SettleResolution, WithdrawResolution,
};
use events::{
    AgentAccount, GradeSet, InvoiceAdvanceCredited, InvoiceAdvanceReverted, InvoiceAdvanced,
    InvoiceAttested, InvoiceDeclined, InvoiceRestStranded, InvoiceSettled, LenderDeposited,
    LenderWithdrawOpened, LenderWithdrawReverted, LenderWithdrew, MaxBuyerExposureSet,
    MinFirstDepositSet, PoolEvent,
};

pub const HARD_MAX_ADVANCE_BPS: u16 = 8000;
const INITIAL_MIN_FIRST_DEPOSIT: u128 = 10_000_000;
const INITIAL_MAX_BUYER_EXPOSURE: u128 = 0;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(65);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(20);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub(crate) enum StorageKey {
    Agents,
    Settlers,
    Invoices,
    Lenders,
    BuyerExposure,
}

#[derive(Debug)]
pub(crate) struct Rejection(String);

impl Rejection {
    pub(crate) fn new(code: &'static str) -> Self {
        Self(code.to_owned())
    }

    pub(crate) fn panic(self) -> ! {
        env::panic_str(&self.0)
    }
}

#[ext_contract(ext_ft)]
#[allow(dead_code, reason = "only the generated `ext_ft` is used")]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    );
}

fn parse_pool_msg(msg: &str) -> Option<PoolMsg> {
    let value: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(msg).ok()?;
    let has_deposit = value.get("deposit").is_some();
    let has_settle = value.get("settle").is_some();
    if has_deposit && has_settle {
        return None;
    }
    if has_deposit {
        return Some(PoolMsg::Deposit);
    }
    if let Some(settle) = value.get("settle") {
        let hash = settle.get("invoice_hash")?.as_str()?;
        return Some(PoolMsg::Settle {
            invoice_hash: InvoiceHash(hash.to_owned()),
        });
    }
    None
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pool {
    admin: AccountId,
    token: AccountId,
    payroll: AccountId,
    books: Books,
    agents: LookupSet<AccountId>,
    settlers: LookupSet<AccountId>,
}

#[near]
impl Pool {
    #[init]
    pub fn new(admin: AccountId, token: AccountId, payroll: AccountId) -> Self {
        Self {
            admin,
            token,
            payroll,
            books: Books::new(INITIAL_MIN_FIRST_DEPOSIT, INITIAL_MAX_BUYER_EXPOSURE),
            agents: LookupSet::new(StorageKey::Agents),
            settlers: LookupSet::new(StorageKey::Settlers),
        }
    }

    pub fn set_grade(&mut self, grade: Grade, max_advance_bps: u16, fee_bps: u16) {
        require!(env::predecessor_account_id() == self.admin, ERR_NOT_ADMIN);
        self.books.set_grade(grade, max_advance_bps, fee_bps);
        let row = self.books.grade(grade);
        let event = [GradeSet {
            grade,
            max_advance_bps: row.max_advance_bps,
            fee_bps: row.fee_bps,
        }];
        PoolEvent::GradeSet(&event).emit();
    }

    pub fn add_agent(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.admin, ERR_NOT_ADMIN);
        if self.agents.insert(account_id.clone()) {
            let event = [AgentAccount {
                account_id: account_id.clone(),
            }];
            PoolEvent::AgentAdded(&event).emit();
        }
    }

    pub fn remove_agent(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.admin, ERR_NOT_ADMIN);
        if self.agents.remove(&account_id) {
            let event = [AgentAccount { account_id }];
            PoolEvent::AgentRemoved(&event).emit();
        }
    }

    pub fn add_settler(&mut self, account_id: AccountId) {
        require!(env::predecessor_account_id() == self.admin, ERR_NOT_ADMIN);
        if self.settlers.insert(account_id.clone()) {
            let event = [AgentAccount {
                account_id: account_id.clone(),
            }];
            PoolEvent::SettlerAdded(&event).emit();
        }
    }

    pub fn set_max_buyer_exposure(&mut self, max_buyer_exposure: U128) {
        require!(env::predecessor_account_id() == self.admin, ERR_NOT_ADMIN);
        self.books.set_max_buyer_exposure(max_buyer_exposure.0);
        let event = [MaxBuyerExposureSet { max_buyer_exposure }];
        PoolEvent::MaxBuyerExposureSet(&event).emit();
    }

    pub fn set_min_first_deposit(&mut self, min_first_deposit: U128) {
        // R15: admin sets the minimum first deposit.
        require!(env::predecessor_account_id() == self.admin, ERR_NOT_ADMIN);
        self.books.set_min_first_deposit(min_first_deposit.0);
        let event = [MinFirstDepositSet { min_first_deposit }];
        PoolEvent::MinFirstDepositSet(&event).emit();
    }

    pub fn attest_invoice(
        &mut self,
        invoice_hash: InvoiceHash,
        employer: AccountId,
        buyer_hash: BuyerHash,
        amount: U128,
        due_ts: U64,
        grade: Grade,
        attestation_ref: String,
    ) {
        // R10: only registered agents attest.
        require!(
            self.agents.contains(&env::predecessor_account_id()),
            ERR_NOT_AGENT
        );
        let header = Header {
            employer: employer.clone(),
            buyer_hash: buyer_hash.clone(),
            amount: amount.0,
            due_ts: due_ts.0,
            grade,
            attestation_ref: attestation_ref.clone(),
        };
        let terms = self.books.grade(grade);
        match self.books.attest(invoice_hash.clone(), header, terms) {
            Ok(()) => {}
            Err(rejection) => rejection.panic(),
        }
        let employer_id = employer.clone();
        if grade == Grade::D {
            let event = [InvoiceDeclined {
                invoice_hash: invoice_hash.clone(),
                employer: employer_id.clone(),
                buyer_hash,
                amount,
                due_ts,
                grade,
                attestation_ref: attestation_ref.as_str(),
            }];
            PoolEvent::InvoiceDeclined(&event).emit();
        } else {
            let event = [InvoiceAttested {
                invoice_hash: invoice_hash.clone(),
                employer: employer_id,
                buyer_hash,
                amount,
                due_ts,
                grade,
                attestation_ref: attestation_ref.as_str(),
            }];
            PoolEvent::InvoiceAttested(&event).emit();
        }
    }

    pub fn request_advance(&mut self, invoice_hash: InvoiceHash, amount: U128) {
        let caller = env::predecessor_account_id();
        let begun = match self.books.begin_advance(&invoice_hash, &caller, amount.0) {
            Ok(b) => b,
            Err(rejection) => rejection.panic(),
        };
        let event = [InvoiceAdvanced {
            invoice_hash: invoice_hash.clone(),
            employer: begun.employer.clone(),
            advance: amount,
            fee: U128(begun.fee),
        }];
        PoolEvent::InvoiceAdvanced(&event).emit();
        let msg = near_sdk::serde_json::json!({ "employer": begun.employer }).to_string();
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER_CALL)
            .ft_transfer_call(self.payroll.clone(), amount, None, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_advance_resolved(invoice_hash, amount),
            )
            .detach();
    }

    pub fn withdraw_lender(&mut self, shares: U128) {
        let lender = env::predecessor_account_id();
        let pending = match self.books.begin_withdraw(&lender, shares.0) {
            Ok(p) => p,
            Err(rejection) => rejection.panic(),
        };
        let event = [LenderWithdrawOpened {
            account_id: lender.clone(),
            shares: U128(pending.shares),
            assets: U128(pending.assets),
        }];
        PoolEvent::LenderWithdrawOpened(&event).emit();
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(lender.clone(), U128(pending.assets), None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_withdraw_resolved(
                        lender.clone(),
                        U128(pending.shares),
                        U128(pending.assets),
                    ),
            )
            .detach();
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
        let Some(pool_msg) = parse_pool_msg(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        match pool_msg {
            PoolMsg::Deposit => {
                // R15: a new lender's first deposit meets the floor.
                if self.books.lender_is_new(&sender_id) && amount.0 < self.books.min_first_deposit {
                    env::panic_str(ERR_DEPOSIT_TOO_SMALL);
                }
                let nav = self.books.nav();
                if Books::shares_for_deposit(amount.0, self.books.total_shares, nav).is_none() {
                    return PromiseOrValue::Value(amount);
                };
                let shares_minted = match self.books.deposit(&sender_id, amount.0) {
                    Ok(s) => s,
                    Err(rejection) => rejection.panic(),
                };
                let event = [LenderDeposited {
                    account_id: sender_id,
                    amount,
                    shares: U128(shares_minted),
                }];
                PoolEvent::LenderDeposited(&event).emit();
                PromiseOrValue::Value(U128(0))
            }
            PoolMsg::Settle { invoice_hash } => {
                // R10: only settlers settle.
                if !self.settlers.contains(&sender_id) {
                    env::panic_str(ERR_NOT_SETTLER);
                }
                match self.books.begin_settle(&invoice_hash, amount.0) {
                    SettleAttempt::Refund => PromiseOrValue::Value(amount),
                    SettleAttempt::Settled { rest, employer } => {
                        let view = self
                            .books
                            .invoice_view(&invoice_hash)
                            .expect("settled invoice");
                        let advance = view.advance.expect("advance").0;
                        let fee = view.fee.expect("fee").0;
                        let event = [InvoiceSettled {
                            invoice_hash: invoice_hash.clone(),
                            advance: U128(advance),
                            fee: U128(fee),
                            rest: U128(rest),
                        }];
                        PoolEvent::InvoiceSettled(&event).emit();
                        if rest == 0 {
                            PromiseOrValue::Value(U128(0))
                        } else {
                            let msg =
                                near_sdk::serde_json::json!({ "employer": employer }).to_string();
                            ext_ft::ext(self.token.clone())
                                .with_attached_deposit(ONE_YOCTO)
                                .with_static_gas(GAS_FOR_FT_TRANSFER_CALL)
                                .ft_transfer_call(self.payroll.clone(), U128(rest), None, msg)
                                .then(
                                    Self::ext(env::current_account_id())
                                        .with_static_gas(GAS_FOR_CALLBACK)
                                        .on_settle_resolved(invoice_hash, U128(rest)),
                                )
                                .detach();
                            PromiseOrValue::Value(U128(0))
                        }
                    }
                }
            }
        }
    }

    #[private]
    pub fn on_advance_resolved(
        &mut self,
        invoice_hash: InvoiceHash,
        amount: U128,
        #[callback_result] transfer: Result<U128, PromiseError>,
    ) {
        let used = match transfer {
            Ok(U128(v)) => v,
            Err(_) => 0,
        };
        match self
            .books
            .resolve_advance(&invoice_hash, amount.0, used == amount.0)
        {
            AdvanceResolution::Ignored => {}
            AdvanceResolution::Credited => {
                let event = [InvoiceAdvanceCredited {
                    invoice_hash,
                    advance: amount,
                }];
                PoolEvent::InvoiceAdvanceCredited(&event).emit();
            }
            AdvanceResolution::Reverted => {
                let event = [InvoiceAdvanceReverted {
                    invoice_hash,
                    advance: amount,
                }];
                PoolEvent::InvoiceAdvanceReverted(&event).emit();
            }
        }
    }

    #[private]
    pub fn on_withdraw_resolved(
        &mut self,
        lender: AccountId,
        shares: U128,
        assets: U128,
        #[callback_result] transfer: Result<(), PromiseError>,
    ) {
        let pending = books::PendingWithdraw {
            shares: shares.0,
            assets: assets.0,
        };
        match self
            .books
            .resolve_withdraw(&lender, pending, transfer.is_ok())
        {
            WithdrawResolution::Ignored => {}
            WithdrawResolution::Completed => {
                let event = [LenderWithdrew {
                    account_id: lender,
                    shares,
                    assets,
                }];
                PoolEvent::LenderWithdrew(&event).emit();
            }
            WithdrawResolution::Reverted => {
                let event = [LenderWithdrawReverted {
                    account_id: lender,
                    shares,
                    assets,
                }];
                PoolEvent::LenderWithdrawReverted(&event).emit();
            }
        }
    }

    #[private]
    pub fn on_settle_resolved(
        &mut self,
        invoice_hash: InvoiceHash,
        rest: U128,
        #[callback_result] transfer: Result<U128, PromiseError>,
    ) {
        let used = match transfer {
            Ok(U128(v)) => v,
            Err(_) => 0,
        };
        match self
            .books
            .resolve_settle(&invoice_hash, rest.0, used == rest.0)
        {
            SettleResolution::Ignored | SettleResolution::Forwarded => {}
            SettleResolution::Stranded => {
                let event = [InvoiceRestStranded { invoice_hash, rest }];
                PoolEvent::InvoiceRestStranded(&event).emit();
            }
        }
    }

    pub fn get_invoice(&self, invoice_hash: InvoiceHash) -> Option<books::InvoiceView> {
        self.books.invoice_view(&invoice_hash)
    }

    pub fn get_pool(&self) -> PoolView {
        self.books.pool_view(&self.token, &self.payroll)
    }

    pub fn get_lender(&self, account_id: AccountId) -> Option<LenderView> {
        self.books.lender_view(&account_id)
    }
}
