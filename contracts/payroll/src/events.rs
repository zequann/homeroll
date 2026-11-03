use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, near};

/// NEP-297, standard "homeroll", version "1.0.0". Account ids and amounts only.
/// A one-element slice keeps `data` a JSON array, as SPEC §7 shows.
///
/// The payload structs own their account ids. `#[near(serializers = [json])]` also
/// generates `Deserialize`, which a borrowed `AccountId` does not implement.
#[near(event_json(standard = "homeroll"))]
pub(crate) enum PayrollEvent<'a> {
    #[event_version("1.0.0")]
    EmployerRegistered(&'a [EmployerRegistered]),
    #[event_version("1.0.0")]
    PayeeAdded(&'a [PayeeAdded]),
    #[event_version("1.0.0")]
    RunSubmitted(&'a [RunSubmitted<'a>]),
}

#[near(serializers = [json])]
pub(crate) struct EmployerRegistered {
    pub(crate) employer: AccountId,
    pub(crate) buffer: U128,
}

#[near(serializers = [json])]
pub(crate) struct PayeeAdded {
    pub(crate) employer: AccountId,
    pub(crate) account_id: AccountId,
    pub(crate) cap: U128,
    pub(crate) active_from: U64,
}

#[near(serializers = [json])]
pub(crate) struct RunSubmitted<'a> {
    pub(crate) employer: AccountId,
    pub(crate) run_id: u64,
    pub(crate) period: &'a str,
    pub(crate) total: U128,
    pub(crate) line_count: u32,
}
