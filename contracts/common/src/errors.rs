//! Contract error codes (SPEC §7, §11). Contracts panic with these exact strings and
//! tests assert on them, so they are a public interface: change one only by agreement,
//! update SPEC in the same change, and keep `packages/shared/src/errors.ts` identical
//! (a test there compares the two lists).

// Shared
pub const ERR_NOT_ADMIN: &str = "ERR_NOT_ADMIN";

// Factory (§7.2)
pub const ERR_INVALID_NAME: &str = "ERR_INVALID_NAME";
pub const ERR_ACCOUNT_EXISTS: &str = "ERR_ACCOUNT_EXISTS";
pub const ERR_TOKEN_REGISTRATION_FAILED: &str = "ERR_TOKEN_REGISTRATION_FAILED";

// Payroll (§7.3)
pub const ERR_EMPLOYER_EXISTS: &str = "ERR_EMPLOYER_EXISTS";
pub const ERR_NOT_EMPLOYER: &str = "ERR_NOT_EMPLOYER";
pub const ERR_UNKNOWN_EMPLOYER: &str = "ERR_UNKNOWN_EMPLOYER";
pub const ERR_WRONG_TOKEN: &str = "ERR_WRONG_TOKEN";
pub const ERR_UNKNOWN_PAYEE: &str = "ERR_UNKNOWN_PAYEE";
pub const ERR_TOO_MANY_PAYEES: &str = "ERR_TOO_MANY_PAYEES";
pub const ERR_TOO_MANY_LINES: &str = "ERR_TOO_MANY_LINES";
pub const ERR_PERIOD_NOT_OPEN: &str = "ERR_PERIOD_NOT_OPEN";
pub const ERR_PAYEE_NOT_ACTIVE: &str = "ERR_PAYEE_NOT_ACTIVE";
pub const ERR_ABOVE_WAGE_CAP: &str = "ERR_ABOVE_WAGE_CAP";
pub const ERR_DUPLICATE_PAYEE: &str = "ERR_DUPLICATE_PAYEE";
pub const ERR_ALREADY_PAID: &str = "ERR_ALREADY_PAID";
pub const ERR_BELOW_BUFFER: &str = "ERR_BELOW_BUFFER";
pub const ERR_INSUFFICIENT_TREASURY: &str = "ERR_INSUFFICIENT_TREASURY";
pub const ERR_RUN_NOT_FOUND: &str = "ERR_RUN_NOT_FOUND";
pub const ERR_RUN_COMPLETE: &str = "ERR_RUN_COMPLETE";

// Pool (§7.4)
pub const ERR_NOT_AGENT: &str = "ERR_NOT_AGENT";
pub const ERR_NOT_SETTLER: &str = "ERR_NOT_SETTLER";
pub const ERR_INVOICE_ALREADY_REGISTERED: &str = "ERR_INVOICE_ALREADY_REGISTERED";
pub const ERR_ADVANCE_ABOVE_CAP: &str = "ERR_ADVANCE_ABOVE_CAP";
pub const ERR_POOL_INSUFFICIENT: &str = "ERR_POOL_INSUFFICIENT";
pub const ERR_BUYER_EXPOSURE: &str = "ERR_BUYER_EXPOSURE";
pub const ERR_DEPOSIT_TOO_SMALL: &str = "ERR_DEPOSIT_TOO_SMALL";

/// `submit_run` names the failing pay line as `<code>:<index>:<account>` (SPEC §7.3),
/// so the UI can resolve the worker's name off-chain. Index is 0-based.
pub fn line_error(code: &str, index: usize, account: &str) -> String {
    format!("{code}:{index}:{account}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_error_matches_spec_format() {
        assert_eq!(
            line_error(ERR_ABOVE_WAGE_CAP, 4, "w-6b1x4k.homeroll.testnet"),
            "ERR_ABOVE_WAGE_CAP:4:w-6b1x4k.homeroll.testnet"
        );
    }
}
