/**
 * The only place money changes currency (SPEC §10). RM is integer sen; tokens are bigint base
 * units with 6 decimals. Components and actions call these functions and never do FX inline.
 *
 * Rounding rules:
 * - Balances and shortfalls shown in RM round to the nearest sen ("nearest").
 * - Amounts a user receives (taka to the family, cash out) round down ("down").
 * - Fees round up ("up").
 */

/** Demo FX constants (SPEC §10), labelled as demo wherever they are shown. */
export const DEMO_SEN_PER_USDC = 420; // RM4.20 per USDC
const TAKA_PER_RM_MILLI = 28_600; // ৳28.60 per RM, in thousandths

/** Token base units, 6 decimals. Never a float. */
export type Units = bigint & { readonly __unit: "Units" };
/** RM as an integer count of sen. */
export type Sen = number & { readonly __sen: "Sen" };

export type RoundMode = "down" | "up" | "nearest";

export function sen(value: number): Sen {
  if (!Number.isSafeInteger(value)) throw new Error(`Sen must be a safe integer, got ${value}`);
  return value as Sen;
}

export function units(value: bigint): Units {
  if (value < 0n) throw new Error(`Units cannot be negative, got ${value}`);
  return value as Units;
}

// 1 USDC = 420 sen = 1_000_000 units, so units = sen * 50_000 / 21.
const UNITS_PER_21_SEN_NUM = 50_000n;
const DEN = 21n;

/** Sen to token units, floored (a payout never exceeds what was asked). */
export function senToUnits(value: Sen): Units {
  return units((BigInt(value) * UNITS_PER_21_SEN_NUM) / DEN);
}

/** Token units to sen. Pick the mode by what the number is (see the rules at the top). */
export function unitsToSen(value: Units, mode: RoundMode): Sen {
  const num = value * DEN;
  const den = UNITS_PER_21_SEN_NUM;
  switch (mode) {
    case "down":
      return sen(Number(num / den));
    case "up":
      return sen(Number((num + den - 1n) / den));
    case "nearest":
      return sen(Number((num * 2n + den) / (den * 2n)));
  }
}

/** Taka the family receives for an RM amount. Payouts round down. */
export function senToTaka(value: Sen): number {
  return Math.floor((value * TAKA_PER_RM_MILLI) / 100_000);
}

/** A fee of `bps` basis points on `value`, rounded up (fees round up). */
export function feeSen(value: Sen, bps: number): Sen {
  return sen(Math.ceil((value * bps) / 10_000));
}

const group = new Intl.NumberFormat("en-US", { useGrouping: true, maximumFractionDigits: 0 });

/**
 * "RM39,400" or "RM1,950.00". Without `decimals` a whole-RM amount has none. Explicit 0 on an
 * amount with sen still shows two decimals: a display never drops money.
 */
export function formatRm(value: Sen, opts?: { decimals?: 0 | 2 }): string {
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const decimals = opts?.decimals ?? (cents === 0 ? 0 : 2);
  const body =
    decimals === 0 && cents === 0
      ? group.format(whole)
      : `${group.format(whole)}.${String(cents).padStart(2, "0")}`;
  return `${negative ? "−" : ""}RM${body}`;
}

/** The digits of an RM amount without the "RM" prefix, for a number that rolls. */
export function formatRmDigits(value: Sen, decimals: 0 | 2): string {
  return formatRm(value, { decimals }).replace("RM", "");
}

/** "464.28 USDC", floored to cents. */
export function formatUsdc(value: Units): string {
  const cents = value / 10_000n;
  const whole = cents / 100n;
  const frac = cents % 100n;
  return `${group.format(whole)}.${String(frac).padStart(2, "0")} USDC`;
}

/** "৳22,628" */
export function formatTaka(value: number): string {
  return `৳${group.format(value)}`;
}

/** "800" or "800.50" typed by a person, to sen. Null when it is not a plain RM amount. */
export function parseRm(text: string): Sen | null {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const [, whole, frac = ""] = match;
  return sen(Number(whole) * 100 + Number(frac.padEnd(2, "0")));
}
