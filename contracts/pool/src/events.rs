use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, near};

use crate::books::{BuyerHash, Grade, InvoiceHash};

#[near(event_json(standard = "homeroll"))]
pub(crate) enum PoolEvent<'a> {
    #[event_version("1.0.0")]
    MinFirstDepositSet(&'a [MinFirstDepositSet]),
    #[event_version("1.0.0")]
    MaxBuyerExposureSet(&'a [MaxBuyerExposureSet]),
    #[event_version("1.0.0")]
    GradeSet(&'a [GradeSet]),
    #[event_version("1.0.0")]
    AgentAdded(&'a [AgentAccount]),
    #[event_version("1.0.0")]
    AgentRemoved(&'a [AgentAccount]),
    #[event_version("1.0.0")]
    SettlerAdded(&'a [AgentAccount]),
    #[event_version("1.0.0")]
    LenderDeposited(&'a [LenderDeposited]),
    #[event_version("1.0.0")]
    LenderWithdrawOpened(&'a [LenderWithdrawOpened]),
    #[event_version("1.0.0")]
    LenderWithdrew(&'a [LenderWithdrew]),
    #[event_version("1.0.0")]
    LenderWithdrawReverted(&'a [LenderWithdrawReverted]),
    #[event_version("1.0.0")]
    InvoiceAttested(&'a [InvoiceAttested<'a>]),
    #[event_version("1.0.0")]
    InvoiceDeclined(&'a [InvoiceDeclined<'a>]),
    #[event_version("1.0.0")]
    InvoiceAdvanced(&'a [InvoiceAdvanced]),
    #[event_version("1.0.0")]
    InvoiceAdvanceCredited(&'a [InvoiceAdvanceCredited]),
    #[event_version("1.0.0")]
    InvoiceAdvanceReverted(&'a [InvoiceAdvanceReverted]),
    #[event_version("1.0.0")]
    InvoiceSettled(&'a [InvoiceSettled]),
    #[event_version("1.0.0")]
    InvoiceRestStranded(&'a [InvoiceRestStranded]),
}

#[near(serializers = [json])]
pub(crate) struct MinFirstDepositSet {
    pub(crate) min_first_deposit: U128,
}

#[near(serializers = [json])]
pub(crate) struct MaxBuyerExposureSet {
    pub(crate) max_buyer_exposure: U128,
}

#[near(serializers = [json])]
pub(crate) struct GradeSet {
    pub(crate) grade: Grade,
    pub(crate) max_advance_bps: u16,
    pub(crate) fee_bps: u16,
}

#[near(serializers = [json])]
pub(crate) struct AgentAccount {
    pub(crate) account_id: AccountId,
}

#[near(serializers = [json])]
pub(crate) struct LenderDeposited {
    pub(crate) account_id: AccountId,
    pub(crate) amount: U128,
    pub(crate) shares: U128,
}

#[near(serializers = [json])]
pub(crate) struct LenderWithdrawOpened {
    pub(crate) account_id: AccountId,
    pub(crate) shares: U128,
    pub(crate) assets: U128,
}

#[near(serializers = [json])]
pub(crate) struct LenderWithdrew {
    pub(crate) account_id: AccountId,
    pub(crate) shares: U128,
    pub(crate) assets: U128,
}

#[near(serializers = [json])]
pub(crate) struct LenderWithdrawReverted {
    pub(crate) account_id: AccountId,
    pub(crate) shares: U128,
    pub(crate) assets: U128,
}

#[near(serializers = [json])]
pub(crate) struct InvoiceAttested<'a> {
    pub(crate) invoice_hash: InvoiceHash,
    pub(crate) employer: AccountId,
    pub(crate) buyer_hash: BuyerHash,
    pub(crate) amount: U128,
    pub(crate) due_ts: U64,
    pub(crate) grade: Grade,
    pub(crate) attestation_ref: &'a str,
}

#[near(serializers = [json])]
pub(crate) struct InvoiceDeclined<'a> {
    pub(crate) invoice_hash: InvoiceHash,
    pub(crate) employer: AccountId,
    pub(crate) buyer_hash: BuyerHash,
    pub(crate) amount: U128,
    pub(crate) due_ts: U64,
    pub(crate) grade: Grade,
    pub(crate) attestation_ref: &'a str,
}

#[near(serializers = [json])]
pub(crate) struct InvoiceAdvanced {
    pub(crate) invoice_hash: InvoiceHash,
    pub(crate) employer: AccountId,
    pub(crate) advance: U128,
    pub(crate) fee: U128,
}

#[near(serializers = [json])]
pub(crate) struct InvoiceAdvanceCredited {
    pub(crate) invoice_hash: InvoiceHash,
    pub(crate) advance: U128,
}

#[near(serializers = [json])]
pub(crate) struct InvoiceAdvanceReverted {
    pub(crate) invoice_hash: InvoiceHash,
    pub(crate) advance: U128,
}

#[near(serializers = [json])]
pub(crate) struct InvoiceSettled {
    pub(crate) invoice_hash: InvoiceHash,
    pub(crate) advance: U128,
    pub(crate) fee: U128,
    pub(crate) rest: U128,
}

#[near(serializers = [json])]
pub(crate) struct InvoiceRestStranded {
    pub(crate) invoice_hash: InvoiceHash,
    pub(crate) rest: U128,
}
