//! The only writer of cash, outstanding, shares, fees, exposure, and invoices.

use homeroll_common::errors::{
    ERR_ADVANCE_ABOVE_CAP, ERR_BUYER_EXPOSURE, ERR_DEPOSIT_TOO_SMALL,
    ERR_INVOICE_ALREADY_REGISTERED, ERR_NOT_EMPLOYER, ERR_POOL_INSUFFICIENT,
};
use near_sdk::json_types::{U64, U128};
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, near};

use crate::HARD_MAX_ADVANCE_BPS;
use crate::Rejection;
use crate::StorageKey;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grade {
    A,
    B,
    C,
    D,
}

impl Grade {
    pub(crate) const fn index(self) -> usize {
        match self {
            Self::A => 0,
            Self::B => 1,
            Self::C => 2,
            Self::D => 3,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(transparent)]
pub struct InvoiceHash(pub String);

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(transparent)]
pub struct BuyerHash(pub String);

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Terms {
    pub max_advance_bps: u16,
    pub fee_bps: u16,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Credit {
    Sending,
    Credited,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Forward {
    None,
    Sending { rest: u128 },
    Stranded { rest: u128 },
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub(crate) struct Header {
    pub employer: AccountId,
    pub buyer_hash: BuyerHash,
    pub amount: u128,
    pub due_ts: u64,
    pub grade: Grade,
    pub attestation_ref: String,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub(crate) enum Invoice {
    Attested {
        header: Header,
        max_advance_bps: u16,
        fee_bps: u16,
    },
    Advanced {
        header: Header,
        advance: u128,
        fee: u128,
        max_advance_bps: u16,
        fee_bps: u16,
        credit: Credit,
    },
    Settled {
        header: Header,
        advance: u128,
        fee: u128,
        forward: Forward,
    },
    Declined {
        header: Header,
    },
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub(crate) struct PendingWithdraw {
    pub shares: u128,
    pub assets: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub(crate) struct Lender {
    pub shares: u128,
    pub pending: Option<PendingWithdraw>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PoolMsg {
    Deposit,
    Settle { invoice_hash: InvoiceHash },
}

pub(crate) struct AdvanceBegun {
    pub employer: AccountId,
    pub fee: u128,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AdvanceResolution {
    Ignored,
    Credited,
    Reverted,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WithdrawResolution {
    Ignored,
    Completed,
    Reverted,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SettleAttempt {
    Refund,
    Settled { rest: u128, employer: AccountId },
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SettleResolution {
    Ignored,
    Forwarded,
    Stranded,
}

#[near(serializers = [json])]
pub struct TermsView {
    pub max_advance_bps: u16,
    pub fee_bps: u16,
}

#[near(serializers = [json])]
pub struct GradesView {
    #[serde(rename = "A")]
    pub a: TermsView,
    #[serde(rename = "B")]
    pub b: TermsView,
    #[serde(rename = "C")]
    pub c: TermsView,
    #[serde(rename = "D")]
    pub d: TermsView,
}

#[near(serializers = [json])]
#[serde(rename_all = "PascalCase")]
pub enum InvoiceStatusView {
    Attested,
    Advanced,
    Settled,
    Declined,
}

#[near(serializers = [json])]
pub struct InvoiceView {
    pub employer: AccountId,
    pub buyer_hash: BuyerHash,
    pub amount: U128,
    pub due_ts: U64,
    pub grade: Grade,
    pub attestation_ref: String,
    pub status: InvoiceStatusView,
    pub advance: Option<U128>,
    pub fee: Option<U128>,
    pub credited: bool,
    pub stranded_rest: U128,
}

#[near(serializers = [json])]
pub struct PoolView {
    pub cash: U128,
    pub outstanding: U128,
    pub total_shares: U128,
    pub nav: U128,
    pub fees_earned: U128,
    pub min_first_deposit: U128,
    pub max_buyer_exposure: U128,
    pub token: AccountId,
    pub payroll: AccountId,
    pub grades: GradesView,
}

#[near(serializers = [json])]
pub struct LenderView {
    pub shares: U128,
    pub pending_assets: Option<U128>,
}

#[near(serializers = [borsh])]
pub(crate) struct Books {
    pub cash: u128,
    pub outstanding: u128,
    pub total_shares: u128,
    pub fees_earned: u128,
    pub min_first_deposit: u128,
    pub max_buyer_exposure: u128,
    grades: [Terms; 4],
    invoices: LookupMap<InvoiceHash, Invoice>,
    lenders: LookupMap<AccountId, Lender>,
    buyer_exposure: LookupMap<BuyerHash, u128>,
}

impl Books {
    pub(crate) fn new(min_first_deposit: u128, max_buyer_exposure: u128) -> Self {
        Self {
            cash: 0,
            outstanding: 0,
            total_shares: 0,
            fees_earned: 0,
            min_first_deposit,
            max_buyer_exposure,
            grades: [
                Terms {
                    max_advance_bps: 8000,
                    fee_bps: 150,
                },
                Terms {
                    max_advance_bps: 7000,
                    fee_bps: 220,
                },
                Terms {
                    max_advance_bps: 6000,
                    fee_bps: 280,
                },
                Terms {
                    max_advance_bps: 0,
                    fee_bps: 0,
                },
            ],
            invoices: LookupMap::new(StorageKey::Invoices),
            lenders: LookupMap::new(StorageKey::Lenders),
            buyer_exposure: LookupMap::new(StorageKey::BuyerExposure),
        }
    }

    pub(crate) fn nav(&self) -> u128 {
        self.cash
            .checked_add(self.outstanding)
            .expect("nav overflow")
    }

    pub(crate) fn grade(&self, grade: Grade) -> Terms {
        self.grades[grade.index()]
    }

    pub(crate) fn set_grade(&mut self, grade: Grade, max_advance_bps: u16, fee_bps: u16) {
        // R8: max advance bps clamped to 8000.
        self.grades[grade.index()] = Terms {
            max_advance_bps: max_advance_bps.min(HARD_MAX_ADVANCE_BPS),
            fee_bps: fee_bps.min(10_000),
        };
    }

    pub(crate) fn set_max_buyer_exposure(&mut self, max_buyer_exposure: u128) {
        self.max_buyer_exposure = max_buyer_exposure;
    }

    pub(crate) fn set_min_first_deposit(&mut self, min_first_deposit: u128) {
        self.min_first_deposit = min_first_deposit;
    }

    pub(crate) fn shares_for_deposit(amount: u128, total_shares: u128, nav: u128) -> Option<u128> {
        if amount == 0 {
            return None;
        }
        if total_shares == 0 {
            if nav == 0 {
                return Some(amount);
            }
            return None;
        }
        let shares = amount
            .checked_mul(total_shares)
            .and_then(|v| v.checked_div(nav))?;
        if shares == 0 { None } else { Some(shares) }
    }

    pub(crate) fn assets_for_shares(
        shares: u128,
        total_shares: u128,
        nav: u128,
        cash: u128,
    ) -> Result<u128, Rejection> {
        if total_shares == 0 || shares == 0 {
            return Err(Rejection::new(ERR_POOL_INSUFFICIENT));
        }
        let assets = shares
            .checked_mul(nav)
            .and_then(|v| v.checked_div(total_shares))
            .unwrap_or(0);
        if assets == 0 || assets > cash {
            Err(Rejection::new(ERR_POOL_INSUFFICIENT))
        } else {
            Ok(assets)
        }
    }

    pub(crate) fn fee_on_advance(advance: u128, fee_bps: u16) -> u128 {
        let fee_bps = u128::from(fee_bps);
        let q = advance / 10_000 * fee_bps;
        let r = advance % 10_000 * fee_bps;
        q + r.div_ceil(10_000)
    }

    pub(crate) fn advance_cap(amount: u128, max_bps: u16) -> u128 {
        let bps = u128::from(max_bps.min(HARD_MAX_ADVANCE_BPS));
        amount.checked_mul(bps).unwrap_or(0) / 10_000
    }

    pub(crate) fn lender_is_new(&self, lender: &AccountId) -> bool {
        !self.lenders.contains_key(lender)
    }

    pub(crate) fn deposit(&mut self, lender: &AccountId, amount: u128) -> Result<u128, Rejection> {
        // R15: a new lender's first deposit meets the floor.
        if self.lender_is_new(lender) && amount < self.min_first_deposit {
            return Err(Rejection::new(ERR_DEPOSIT_TOO_SMALL));
        }
        let nav = self.nav();
        let shares = Self::shares_for_deposit(amount, self.total_shares, nav)
            .ok_or_else(|| Rejection::new(ERR_POOL_INSUFFICIENT))?;
        self.cash = self
            .cash
            .checked_add(amount)
            .ok_or_else(|| Rejection::new(ERR_POOL_INSUFFICIENT))?;
        self.total_shares = self
            .total_shares
            .checked_add(shares)
            .ok_or_else(|| Rejection::new(ERR_POOL_INSUFFICIENT))?;
        let mut row = self.lenders.get(lender).cloned().unwrap_or(Lender {
            shares: 0,
            pending: None,
        });
        row.shares = row
            .shares
            .checked_add(shares)
            .ok_or_else(|| Rejection::new(ERR_POOL_INSUFFICIENT))?;
        self.lenders.insert(lender.clone(), row);
        Ok(shares)
    }

    pub(crate) fn attest(
        &mut self,
        hash: InvoiceHash,
        header: Header,
        terms: Terms,
    ) -> Result<(), Rejection> {
        // R7: one invoice, one registration.
        if self.invoices.contains_key(&hash) {
            return Err(Rejection::new(ERR_INVOICE_ALREADY_REGISTERED));
        }
        let invoice = if header.grade == Grade::D {
            Invoice::Declined { header }
        } else {
            Invoice::Attested {
                header,
                max_advance_bps: terms.max_advance_bps,
                fee_bps: terms.fee_bps,
            }
        };
        self.invoices.insert(hash, invoice);
        Ok(())
    }

    pub(crate) fn begin_advance(
        &mut self,
        hash: &InvoiceHash,
        caller: &AccountId,
        amount: u128,
    ) -> Result<AdvanceBegun, Rejection> {
        let Some(invoice) = self.invoices.get(hash).cloned() else {
            return Err(Rejection::new(ERR_NOT_EMPLOYER));
        };
        let (header, max_bps, fee_bps) = match invoice {
            Invoice::Attested {
                header,
                max_advance_bps,
                fee_bps,
            } => (header, max_advance_bps, fee_bps),
            // R8: grade D cannot be advanced.
            Invoice::Declined { .. } => return Err(Rejection::new(ERR_ADVANCE_ABOVE_CAP)),
            // R7: one advance per invoice.
            Invoice::Advanced { .. } | Invoice::Settled { .. } => {
                return Err(Rejection::new(ERR_INVOICE_ALREADY_REGISTERED));
            }
        };
        if caller != &header.employer {
            return Err(Rejection::new(ERR_NOT_EMPLOYER));
        }
        let cap = Self::advance_cap(header.amount, max_bps);
        // R8: advance <= grade cap
        if amount > cap {
            return Err(Rejection::new(ERR_ADVANCE_ABOVE_CAP));
        }
        if self.cash < amount {
            return Err(Rejection::new(ERR_POOL_INSUFFICIENT));
        }
        let exposure = self
            .buyer_exposure
            .get(&header.buyer_hash)
            .copied()
            .unwrap_or(0);
        // R11: per-buyer exposure limit.
        let new_exposure = exposure
            .checked_add(amount)
            .ok_or_else(|| Rejection::new(ERR_BUYER_EXPOSURE))?;
        if new_exposure > self.max_buyer_exposure {
            return Err(Rejection::new(ERR_BUYER_EXPOSURE));
        }
        self.cash -= amount;
        self.outstanding = self
            .outstanding
            .checked_add(amount)
            .expect("outstanding overflow");
        if exposure == 0 {
            self.buyer_exposure
                .insert(header.buyer_hash.clone(), new_exposure);
        } else {
            *self
                .buyer_exposure
                .get_mut(&header.buyer_hash)
                .expect("exposure") = new_exposure;
        }
        let fee = Self::fee_on_advance(amount, fee_bps);
        let employer = header.employer.clone();
        self.invoices.insert(
            hash.clone(),
            Invoice::Advanced {
                header,
                advance: amount,
                fee,
                max_advance_bps: max_bps,
                fee_bps,
                credit: Credit::Sending,
            },
        );
        Ok(AdvanceBegun { employer, fee })
    }

    pub(crate) fn resolve_advance(
        &mut self,
        hash: &InvoiceHash,
        amount: u128,
        credited: bool,
    ) -> AdvanceResolution {
        let Some(invoice) = self.invoices.get(hash).cloned() else {
            return AdvanceResolution::Ignored;
        };
        let Invoice::Advanced {
            header,
            advance,
            fee,
            max_advance_bps,
            fee_bps,
            credit,
        } = invoice
        else {
            return AdvanceResolution::Ignored;
        };
        if advance != amount {
            return AdvanceResolution::Ignored;
        }
        match credit {
            Credit::Credited => AdvanceResolution::Ignored,
            Credit::Sending if credited => {
                self.invoices.insert(
                    hash.clone(),
                    Invoice::Advanced {
                        header,
                        advance,
                        fee,
                        max_advance_bps,
                        fee_bps,
                        credit: Credit::Credited,
                    },
                );
                AdvanceResolution::Credited
            }
            Credit::Sending => {
                if self.outstanding < amount {
                    return AdvanceResolution::Ignored;
                }
                self.cash = self.cash.checked_add(amount).expect("cash overflow");
                self.outstanding -= amount;
                let exposure = self
                    .buyer_exposure
                    .get(&header.buyer_hash)
                    .copied()
                    .unwrap_or(0);
                if exposure >= amount {
                    let next = exposure - amount;
                    if next == 0 {
                        self.buyer_exposure.remove(&header.buyer_hash);
                    } else {
                        *self
                            .buyer_exposure
                            .get_mut(&header.buyer_hash)
                            .expect("exposure") = next;
                    }
                }
                self.invoices.insert(
                    hash.clone(),
                    Invoice::Attested {
                        header,
                        max_advance_bps,
                        fee_bps,
                    },
                );
                AdvanceResolution::Reverted
            }
        }
    }

    pub(crate) fn begin_withdraw(
        &mut self,
        lender: &AccountId,
        shares: u128,
    ) -> Result<PendingWithdraw, Rejection> {
        let Some(row) = self.lenders.get(lender).cloned() else {
            return Err(Rejection::new(ERR_POOL_INSUFFICIENT));
        };
        if row.pending.is_some() {
            return Err(Rejection::new(ERR_POOL_INSUFFICIENT));
        }
        if row.shares < shares {
            return Err(Rejection::new(ERR_POOL_INSUFFICIENT));
        }
        let nav = self.nav();
        let assets = Self::assets_for_shares(shares, self.total_shares, nav, self.cash)?;
        let mut updated = row;
        updated.shares -= shares;
        updated.pending = Some(PendingWithdraw { shares, assets });
        self.cash -= assets;
        self.total_shares -= shares;
        self.lenders.insert(lender.clone(), updated);
        Ok(PendingWithdraw { shares, assets })
    }

    pub(crate) fn resolve_withdraw(
        &mut self,
        lender: &AccountId,
        pending: PendingWithdraw,
        ok: bool,
    ) -> WithdrawResolution {
        let Some(row) = self.lenders.get(lender).cloned() else {
            return WithdrawResolution::Ignored;
        };
        let Some(stored) = row.pending.clone() else {
            return WithdrawResolution::Ignored;
        };
        if stored.shares != pending.shares || stored.assets != pending.assets {
            return WithdrawResolution::Ignored;
        }
        if ok {
            let mut updated = row;
            updated.pending = None;
            if updated.shares == 0 {
                self.lenders.remove(lender);
            } else {
                self.lenders.insert(lender.clone(), updated);
            }
            WithdrawResolution::Completed
        } else {
            let mut updated = row;
            updated.shares = updated
                .shares
                .checked_add(pending.shares)
                .expect("shares overflow");
            updated.pending = None;
            self.cash = self
                .cash
                .checked_add(pending.assets)
                .expect("cash overflow");
            self.total_shares = self
                .total_shares
                .checked_add(pending.shares)
                .expect("shares overflow");
            self.lenders.insert(lender.clone(), updated);
            WithdrawResolution::Reverted
        }
    }

    pub(crate) fn begin_settle(&mut self, hash: &InvoiceHash, payment: u128) -> SettleAttempt {
        let Some(invoice) = self.invoices.get(hash).cloned() else {
            return SettleAttempt::Refund;
        };
        let Invoice::Advanced {
            header,
            advance,
            fee,
            credit,
            ..
        } = invoice
        else {
            return SettleAttempt::Refund;
        };
        if credit != Credit::Credited {
            return SettleAttempt::Refund;
        }
        let owed = advance.checked_add(fee).expect("owed overflow");
        if payment < owed {
            return SettleAttempt::Refund;
        }
        let rest = payment - owed;
        self.cash = self.cash.checked_add(owed).expect("cash overflow");
        self.outstanding = self
            .outstanding
            .checked_sub(advance)
            .expect("outstanding underflow");
        self.fees_earned = self.fees_earned.checked_add(fee).expect("fees overflow");
        let exposure = self
            .buyer_exposure
            .get(&header.buyer_hash)
            .copied()
            .unwrap_or(0);
        if exposure >= advance {
            let next = exposure - advance;
            if next == 0 {
                self.buyer_exposure.remove(&header.buyer_hash);
            } else {
                *self
                    .buyer_exposure
                    .get_mut(&header.buyer_hash)
                    .expect("exposure") = next;
            }
        }
        let employer = header.employer.clone();
        let forward = if rest == 0 {
            Forward::None
        } else {
            Forward::Sending { rest }
        };
        self.invoices.insert(
            hash.clone(),
            Invoice::Settled {
                header,
                advance,
                fee,
                forward,
            },
        );
        SettleAttempt::Settled { rest, employer }
    }

    pub(crate) fn resolve_settle(
        &mut self,
        hash: &InvoiceHash,
        rest: u128,
        forwarded: bool,
    ) -> SettleResolution {
        let Some(invoice) = self.invoices.get(hash).cloned() else {
            return SettleResolution::Ignored;
        };
        let Invoice::Settled {
            header,
            advance,
            fee,
            forward,
        } = invoice
        else {
            return SettleResolution::Ignored;
        };
        let Forward::Sending { rest: expected } = forward else {
            return SettleResolution::Ignored;
        };
        if expected != rest {
            return SettleResolution::Ignored;
        }
        if forwarded {
            self.invoices.insert(
                hash.clone(),
                Invoice::Settled {
                    header,
                    advance,
                    fee,
                    forward: Forward::None,
                },
            );
            SettleResolution::Forwarded
        } else {
            self.invoices.insert(
                hash.clone(),
                Invoice::Settled {
                    header,
                    advance,
                    fee,
                    forward: Forward::Stranded { rest },
                },
            );
            SettleResolution::Stranded
        }
    }

    pub(crate) fn invoice_view(&self, hash: &InvoiceHash) -> Option<InvoiceView> {
        let invoice = self.invoices.get(hash)?;
        Some(invoice_to_view(invoice))
    }

    pub(crate) fn pool_view(&self, token: &AccountId, payroll: &AccountId) -> PoolView {
        let g = |grade: Grade| {
            let t = self.grade(grade);
            TermsView {
                max_advance_bps: t.max_advance_bps,
                fee_bps: t.fee_bps,
            }
        };
        PoolView {
            cash: U128(self.cash),
            outstanding: U128(self.outstanding),
            total_shares: U128(self.total_shares),
            nav: U128(self.nav()),
            fees_earned: U128(self.fees_earned),
            min_first_deposit: U128(self.min_first_deposit),
            max_buyer_exposure: U128(self.max_buyer_exposure),
            token: token.clone(),
            payroll: payroll.clone(),
            grades: GradesView {
                a: g(Grade::A),
                b: g(Grade::B),
                c: g(Grade::C),
                d: g(Grade::D),
            },
        }
    }

    pub(crate) fn lender_view(&self, account_id: &AccountId) -> Option<LenderView> {
        let row = self.lenders.get(account_id)?;
        Some(LenderView {
            shares: U128(row.shares),
            pending_assets: row.pending.as_ref().map(|p| U128(p.assets)),
        })
    }
}

fn invoice_to_view(invoice: &Invoice) -> InvoiceView {
    match invoice {
        Invoice::Attested { header, .. } => InvoiceView {
            employer: header.employer.clone(),
            buyer_hash: header.buyer_hash.clone(),
            amount: U128(header.amount),
            due_ts: U64(header.due_ts),
            grade: header.grade,
            attestation_ref: header.attestation_ref.clone(),
            status: InvoiceStatusView::Attested,
            advance: None,
            fee: None,
            credited: false,
            stranded_rest: U128(0),
        },
        Invoice::Advanced {
            header,
            advance,
            fee,
            credit,
            ..
        } => InvoiceView {
            employer: header.employer.clone(),
            buyer_hash: header.buyer_hash.clone(),
            amount: U128(header.amount),
            due_ts: U64(header.due_ts),
            grade: header.grade,
            attestation_ref: header.attestation_ref.clone(),
            status: InvoiceStatusView::Advanced,
            advance: Some(U128(*advance)),
            fee: Some(U128(*fee)),
            credited: matches!(credit, Credit::Credited),
            stranded_rest: U128(0),
        },
        Invoice::Settled {
            header,
            advance,
            fee,
            forward,
        } => {
            let stranded = match forward {
                Forward::Stranded { rest } => *rest,
                _ => 0,
            };
            InvoiceView {
                employer: header.employer.clone(),
                buyer_hash: header.buyer_hash.clone(),
                amount: U128(header.amount),
                due_ts: U64(header.due_ts),
                grade: header.grade,
                attestation_ref: header.attestation_ref.clone(),
                status: InvoiceStatusView::Settled,
                advance: Some(U128(*advance)),
                fee: Some(U128(*fee)),
                credited: true,
                stranded_rest: U128(stranded),
            }
        }
        Invoice::Declined { header } => InvoiceView {
            employer: header.employer.clone(),
            buyer_hash: header.buyer_hash.clone(),
            amount: U128(header.amount),
            due_ts: U64(header.due_ts),
            grade: header.grade,
            attestation_ref: header.attestation_ref.clone(),
            status: InvoiceStatusView::Declined,
            advance: None,
            fee: None,
            credited: false,
            stranded_rest: U128(0),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_pool_mints_one_share_per_base_unit() {
        assert_eq!(
            Books::shares_for_deposit(10_000_000, 0, 0),
            Some(10_000_000)
        );
    }

    #[test]
    fn fee_rounds_up() {
        assert_eq!(Books::fee_on_advance(80_000_000, 150), 1_200_000);
    }

    #[test]
    fn advance_cap_clamps_to_hard_max() {
        assert_eq!(Books::advance_cap(100_000_000, 9000), 80_000_000);
    }

    #[test]
    fn second_resolve_advance_is_ignored() {
        let mut books = Books::new(10_000_000, 80_000_000);
        books.cash = 100_000_000;
        let hash = InvoiceHash("inv1".to_owned());
        let header = Header {
            employer: "employer.sandbox".parse().unwrap(),
            buyer_hash: BuyerHash("buyer".to_owned()),
            amount: 100_000_000,
            due_ts: 0,
            grade: Grade::A,
            attestation_ref: "none".to_owned(),
        };
        books
            .attest(
                hash.clone(),
                header,
                Terms {
                    max_advance_bps: 8000,
                    fee_bps: 150,
                },
            )
            .unwrap();
        books.cash = 100_000_000;
        books.max_buyer_exposure = 100_000_000;
        books
            .begin_advance(&hash, &"employer.sandbox".parse().unwrap(), 80_000_000)
            .unwrap();
        assert_eq!(
            books.resolve_advance(&hash, 80_000_000, true),
            AdvanceResolution::Credited
        );
        assert_eq!(
            books.resolve_advance(&hash, 80_000_000, true),
            AdvanceResolution::Ignored
        );
    }

    #[test]
    fn underpayment_settle_refunds() {
        let mut books = Books::new(10_000_000, 0);
        let hash = InvoiceHash("inv2".to_owned());
        let header = Header {
            employer: "e.sandbox".parse().unwrap(),
            buyer_hash: BuyerHash("b".to_owned()),
            amount: 100_000_000,
            due_ts: 0,
            grade: Grade::A,
            attestation_ref: "none".to_owned(),
        };
        books.cash = 100_000_000;
        books.max_buyer_exposure = 100_000_000;
        books
            .attest(
                hash.clone(),
                header,
                Terms {
                    max_advance_bps: 8000,
                    fee_bps: 150,
                },
            )
            .unwrap();
        books
            .begin_advance(&hash, &"e.sandbox".parse().unwrap(), 80_000_000)
            .unwrap();
        books.resolve_advance(&hash, 80_000_000, true);
        let cash_before = books.cash;
        assert!(matches!(
            books.begin_settle(&hash, 80_000_000),
            SettleAttempt::Refund
        ));
        assert_eq!(books.cash, cash_before);
    }

    #[test]
    fn settle_with_zero_rest_needs_no_forward() {
        let mut books = Books::new(10_000_000, 0);
        let hash = InvoiceHash("inv3".to_owned());
        let header = Header {
            employer: "e.sandbox".parse().unwrap(),
            buyer_hash: BuyerHash("b".to_owned()),
            amount: 100_000_000,
            due_ts: 0,
            grade: Grade::A,
            attestation_ref: "none".to_owned(),
        };
        books.cash = 100_000_000;
        books.max_buyer_exposure = 100_000_000;
        books
            .attest(
                hash.clone(),
                header,
                Terms {
                    max_advance_bps: 8000,
                    fee_bps: 150,
                },
            )
            .unwrap();
        books
            .begin_advance(&hash, &"e.sandbox".parse().unwrap(), 80_000_000)
            .unwrap();
        books.resolve_advance(&hash, 80_000_000, true);
        match books.begin_settle(&hash, 81_200_000) {
            SettleAttempt::Settled { rest, .. } => assert_eq!(rest, 0),
            _ => panic!("expected settled"),
        }
    }
}
