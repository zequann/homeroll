use near_sdk::near;

/// Limits the payroll contract enforces (SPEC §7.3 Config). Passed into `Employer` methods
/// explicitly, so unit tests use tiny limits without a setter.
#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
pub(crate) struct Config {
    /// Check 1 of `submit_run`: bounds the work before any line is read.
    pub(crate) max_lines_per_run: u32,
    /// R15: payee limit per employer (ADR-0002: the contract pays for storage).
    pub(crate) max_payees_per_employer: u32,
    /// R3: hold before a payee added after onboarding becomes active.
    pub(crate) hold_ns: u64,
}

/// SPEC §4: the demo employer pays 40 workers. This is the floor the demo needs, not a gas
/// measurement. Q3 measures the ceiling and replaces it here and in SPEC.
const DEMO_PAYEES: u32 = 40;
/// R3 and GLOSSARY "Hold": 48 hours.
const HOLD_NS: u64 = 48 * 60 * 60 * 1_000_000_000;

impl Config {
    pub(crate) const INITIAL: Self = Self {
        max_lines_per_run: DEMO_PAYEES,
        max_payees_per_employer: DEMO_PAYEES,
        hold_ns: HOLD_NS,
    };
}
