use near_sdk::near;

/// Limits the payroll contract enforces (SPEC §7.3 Config). Passed into `Employer` methods
/// explicitly, so unit tests use tiny limits without a setter.
#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
pub(crate) struct Config {
    /// Check 1 of `submit_run`: bounds the work before any line is read.
    pub(crate) max_lines_per_run: u32,
    /// How many `Reserved` lines `pay_run` may send or skip in one call.
    pub(crate) max_lines_per_call: u32,
    /// R15: payee limit per employer (ADR-0002: the contract pays for storage).
    pub(crate) max_payees_per_employer: u32,
    /// R3: hold before a payee added after onboarding becomes active.
    pub(crate) hold_ns: u64,
}

/// SPEC §4: the demo employer pays 40 workers in one run. `submit_run` does not transfer.
const DEMO_PAYEES: u32 = 40;
/// `pay_run` attaches 25 Tgas per line. 35 lines fit in 995 Tgas in the sandbox and do not
/// fit on testnet (tx 3A26sakHbdFEyR4gCVKtxSQkBoeJ275CM3yfSp1LYay1). 20 leaves enough
/// headroom for a 1 NEAR function-call key. SPEC §7.3.
const MAX_LINES_PER_CALL: u32 = 20;
/// R3 and GLOSSARY "Hold": 48 hours.
const HOLD_NS: u64 = 48 * 60 * 60 * 1_000_000_000;

impl Config {
    pub(crate) const INITIAL: Self = Self {
        max_lines_per_run: DEMO_PAYEES,
        max_lines_per_call: MAX_LINES_PER_CALL,
        max_payees_per_employer: DEMO_PAYEES,
        hold_ns: HOLD_NS,
    };

    /// The batch size is code, not stored state. `new` copies it into state, and a
    /// wasm swap does not rewrite that copy.
    pub(crate) const fn lines_per_call() -> u32 {
        MAX_LINES_PER_CALL
    }
}
