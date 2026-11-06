import { createHash } from 'node:crypto';

/**
 * Deterministic canonical JSON: keys sorted recursively, no whitespace.
 * Rejects undefined, functions, symbols, NaN/Infinity and any non-integer number
 * (money must be a decimal string or bigint, never a float).
 * bigint is emitted as bare integer digits.
 */
export function canonicalJson(value: unknown): string {
  return ser(value, '$');
}

function ser(v: unknown, path: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      return v.toString();
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      if (!Number.isSafeInteger(v))
        throw new TypeError(`canonicalJson: non-integer/unsafe number at ${path} (use string or bigint for money)`);
      return Object.is(v, -0) ? '0' : String(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x, i) => ser(x, `${path}[${i}]`)).join(',') + ']';
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null)
        throw new TypeError(`canonicalJson: unsupported object type at ${path}`);
      const o = v as Record<string, unknown>;
      return (
        '{' +
        Object.keys(o)
          .sort()
          .map((k) => {
            if (o[k] === undefined) throw new TypeError(`canonicalJson: undefined at ${path}.${k}`);
            return JSON.stringify(k) + ':' + ser(o[k], `${path}.${k}`);
          })
          .join(',') +
        '}'
      );
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}

/** invoice_hash = sha256(canonical_waybill_json), 64-char lowercase hex. */
export function invoiceHash(waybill: unknown): string {
  return createHash('sha256').update(canonicalJson(waybill), 'utf8').digest('hex');
}
