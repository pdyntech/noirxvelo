/** Integer accounting (PRD §6, §10.7). All amounts are bigint stroops. Never floats. */

export const STROOPS_PER_XLM = 10_000_000n;
/** Fixed demo rate (PRD §10.4): 1 XLM = PHP 1,000. */
export const PHP_PER_XLM = 1000n;
/** Stroops per whole peso at the demo rate. */
export const STROOPS_PER_PHP = STROOPS_PER_XLM / PHP_PER_XLM;

/** Parse a decimal XLM string/bigint/safe-integer into stroops (up to 7 decimals). */
export function toStroops(xlm: string | number | bigint): bigint {
  if (typeof xlm === 'bigint') return xlm * STROOPS_PER_XLM;
  if (typeof xlm === 'number') {
    if (!Number.isSafeInteger(xlm)) throw new TypeError('toStroops: pass a decimal string, not a float');
    return BigInt(xlm) * STROOPS_PER_XLM;
  }
  const m = /^(-?)(\d+)(?:\.(\d{1,7}))?$/.exec(xlm.trim());
  if (!m) throw new TypeError(`toStroops: invalid XLM amount "${xlm}"`);
  const frac = (m[3] ?? '').padEnd(7, '0');
  const v = BigInt(m[2]!) * STROOPS_PER_XLM + BigInt(frac);
  return m[1] ? -v : v;
}

/** Format stroops as a decimal XLM string (trailing zeros trimmed). */
export function fromStroops(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const whole = abs / STROOPS_PER_XLM;
  const frac = (abs % STROOPS_PER_XLM).toString().padStart(7, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Whole pesos -> stroops at the fixed demo rate. */
export function phpToStroops(php: bigint): bigint {
  return php * STROOPS_PER_PHP;
}

/** Stroops -> whole pesos (rounded down) at the fixed demo rate. */
export function stroopsToPhp(stroops: bigint): bigint {
  return stroops / STROOPS_PER_PHP;
}

export interface Payouts {
  faceValue: bigint;
  /** floor(0.85 V): escrow -> shipowner at advance time. */
  advance: bigint;
  /** floor(0.03 V). */
  yield: bigint;
  /** advance + yield: escrow -> LP at settlement. */
  lpRepayment: bigint;
  /** floor(0.005 V): escrow -> treasury. */
  fee: bigint;
  /** V - lpRepayment - fee: escrow -> shipowner (absorbs rounding). */
  rebate: bigint;
  /** Largest single payout (policy maxAmount) = lpRepayment. */
  maxAmount: bigint;
}

export function computePayouts(faceValue: bigint): Payouts {
  if (faceValue <= 0n) throw new RangeError('face value must be positive');
  const advance = (faceValue * 85n) / 100n;
  const yld = (faceValue * 3n) / 100n;
  const fee = (faceValue * 5n) / 1000n;
  const lpRepayment = advance + yld;
  const rebate = faceValue - lpRepayment - fee;
  return { faceValue, advance, yield: yld, lpRepayment, fee, rebate, maxAmount: lpRepayment };
}

/** Settlement payouts sum (LP + rebate + fee) must equal V exactly. */
export function settlementTotal(p: Payouts): bigint {
  return p.lpRepayment + p.rebate + p.fee;
}
