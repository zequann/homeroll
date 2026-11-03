//! Pay periods (SPEC §7.3, R14, GLOSSARY "Period"): a UTC calendar month written `YYYY-MM`.
//! One calendar for the contract and its tests, so they cannot disagree about "this month".

/// Invariant: 1 <= month <= 12. Only `parse` and `containing` construct one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Period {
    year: u16,
    month: u8,
}

const NS_PER_DAY: u64 = 24 * 60 * 60 * 1_000_000_000;

impl Period {
    /// Exactly four ASCII digits, '-', two ASCII digits 01..=12. Anything else is `None`,
    /// so the accepted text is always the canonical `Display` form.
    pub fn parse(text: &str) -> Option<Self> {
        let (year, month) = text.split_once('-')?;
        if year.len() != 4 || month.len() != 2 {
            return None;
        }
        if !year.bytes().all(|byte| byte.is_ascii_digit())
            || !month.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        let year = year.parse().ok()?;
        let month = month.parse().ok()?;
        if (1..=12).contains(&month) {
            Some(Self { year, month })
        } else {
            None
        }
    }

    /// The UTC calendar month containing `timestamp_ns` (ns since the Unix epoch).
    pub fn containing(timestamp_ns: u64) -> Self {
        let days = i64::try_from(timestamp_ns / NS_PER_DAY).expect("day count fits in i64");
        let (year, month, _) = civil_from_days(days);
        Self {
            year: u16::try_from(year).expect("year fits in u16"),
            month: u8::try_from(month).expect("month fits in u8"),
        }
    }

    /// 2026-01 -> 2025-12.
    pub fn previous(self) -> Self {
        if self.month == 1 {
            Self {
                year: self.year - 1,
                month: 12,
            }
        } else {
            Self {
                year: self.year,
                month: self.month - 1,
            }
        }
    }

    /// R14: open during its own month and the month after, by UTC block time.
    pub fn is_open_at(self, timestamp_ns: u64) -> bool {
        let now = Self::containing(timestamp_ns);
        self == now || self == now.previous()
    }
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 to (year, month, day).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = u64::try_from(z - era * 146_097).expect("day of era is non-negative");
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = i64::try_from(yoe).expect("year of era fits in i64") + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    (
        year,
        u32::try_from(month).expect("month fits in u32"),
        u32::try_from(day).expect("day fits in u32"),
    )
}

impl core::fmt::Display for Period {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{:04}-{:02}", self.year, self.month)
    }
}

#[cfg(test)]
mod tests {
    use super::Period;

    const LEAP_DAY: u64 = 1_709_164_800_000_000_000;
    const MARCH_FIRST: u64 = 1_709_251_200_000_000_000;
    const YEAR_EVE: u64 = 1_767_225_599_000_000_000;
    const NEW_YEAR: u64 = 1_767_225_600_000_000_000;
    const NOVEMBER: u64 = 1_794_700_800_000_000_000;
    const DECEMBER: u64 = 1_796_083_200_000_000_000;
    const OCTOBER: u64 = 1_790_812_800_000_000_000;
    const NEXT_JANUARY: u64 = 1_798_761_600_000_000_000;

    #[test]
    fn parse_accepts_only_canonical_yyyy_mm() {
        assert_eq!(Period::parse("2026-11").unwrap().to_string(), "2026-11");
        assert_eq!(Period::parse("1970-01").unwrap().to_string(), "1970-01");
        assert_eq!(Period::parse("2024-02").unwrap().to_string(), "2024-02");
        for text in [
            "",
            "2026-1",
            "2026-00",
            "2026-13",
            "26-11",
            "20261-1",
            "2026/11",
            "2026-11-01",
            "2026-11 ",
            " 2026-11",
            "+2026-11",
            "abcd-11",
            "2026-1a",
        ] {
            assert_eq!(Period::parse(text), None, "{text}");
        }
    }

    #[test]
    fn previous_month_crosses_the_year_boundary() {
        assert_eq!(
            Period::parse("2026-03").unwrap().previous().to_string(),
            "2026-02"
        );
        assert_eq!(
            Period::parse("2026-01").unwrap().previous().to_string(),
            "2025-12"
        );
        assert_eq!(
            Period::parse("2024-03").unwrap().previous().to_string(),
            "2024-02"
        );
    }

    #[test]
    fn containing_names_the_utc_month_including_leap_day_and_new_year() {
        assert_eq!(Period::containing(0).to_string(), "1970-01");
        assert_eq!(Period::containing(LEAP_DAY).to_string(), "2024-02");
        assert_eq!(Period::containing(MARCH_FIRST).to_string(), "2024-03");
        assert_eq!(Period::containing(YEAR_EVE).to_string(), "2025-12");
        assert_eq!(Period::containing(NEW_YEAR).to_string(), "2026-01");
        assert_eq!(Period::containing(NOVEMBER).to_string(), "2026-11");
    }

    #[test]
    fn a_period_is_open_in_its_month_and_the_next() {
        let november = Period::parse("2026-11").unwrap();
        assert!(november.is_open_at(NOVEMBER));
        assert!(november.is_open_at(DECEMBER));
        assert!(!november.is_open_at(OCTOBER));
        assert!(!november.is_open_at(NEXT_JANUARY));

        let december = Period::parse("2025-12").unwrap();
        assert!(december.is_open_at(YEAR_EVE));
        assert!(december.is_open_at(NEW_YEAR));
        assert!(!december.is_open_at(NOVEMBER));
    }
}
