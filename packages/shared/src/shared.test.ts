import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DuplicateInvoiceError, MemoryStore, SEED_WAYBILL, canonicalJson, computePayouts, fromStroops,
  invoiceHash, loadSeed, seedInvoice, settlementTotal, toStroops,
} from './index.js';

describe('canonical hashing', () => {
  it('is key-order independent and 64-char lowercase hex', () => {
    const a = { b: 1, a: { y: [1, { q: 'x', p: 'z' }], x: null } };
    const b = { a: { x: null, y: [1, { p: 'z', q: 'x' }] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"x":null,"y":[1,{"p":"z","q":"x"}]},"b":1}');
    expect(invoiceHash(a)).toBe(invoiceHash(b));
    expect(invoiceHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(invoiceHash({ a: 2 })).not.toBe(invoiceHash({ a: 1 }));
  });
  it('rejects undefined, NaN, Infinity and floats', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
    expect(() => canonicalJson({ amount: 1000.5 })).toThrow();
    expect(canonicalJson({ amount: 10n })).toBe('{"amount":10}');
  });
});

describe('store', () => {
  it('rejects duplicate invoice_hash', () => {
    const s = new MemoryStore({ filePath: null });
    s.addInvoice(seedInvoice());
    expect(() => s.addInvoice({ ...seedInvoice(), id: 'other' })).toThrow(DuplicateInvoiceError);
  });
  it('dedupes webhooks by event_id', () => {
    const s = new MemoryStore({ filePath: null });
    const e = { event_id: 'evt_1', event_type: 'payment.succeeded', payload_json: {}, verified: true, received_at: 't' };
    expect(s.addWebhook(e).inserted).toBe(true);
    expect(s.addWebhook({ ...e, verified: false }).inserted).toBe(false);
    expect(s.listWebhooks()).toHaveLength(1);
    expect(s.getWebhook('evt_1')?.verified).toBe(true);
  });
  it('survives restart via JSON file with bigint intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nxv-'));
    const filePath = join(dir, 'state.json');
    try {
      const s1 = new MemoryStore({ filePath });
      loadSeed(s1);
      const s2 = new MemoryStore({ filePath });
      expect(s2.getInvoice('inv_seed_001')?.face_value_xlm).toBe(10_000_000_000n);
      expect(() => s2.addInvoice({ ...seedInvoice(), id: 'x' })).toThrow(DuplicateInvoiceError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seed', () => {
  it('loads idempotently with expected values', () => {
    const s = new MemoryStore({ filePath: null });
    const a = loadSeed(s);
    const b = loadSeed(s);
    expect(a).toEqual(b);
    expect(s.listInvoices()).toHaveLength(1);
    expect(a.face_value_php).toBe(1_000_000n);
    expect(a.face_value_xlm).toBe(toStroops(1000));
    expect(a.invoice_hash).toBe(invoiceHash(SEED_WAYBILL));
    expect(a.route).toContain('Cebu');
  });
});

describe('math', () => {
  it('matches PRD 10.7 table for 1000 XLM', () => {
    const p = computePayouts(toStroops(1000));
    expect(fromStroops(p.advance)).toBe('850');
    expect(fromStroops(p.lpRepayment)).toBe('880');
    expect(fromStroops(p.rebate)).toBe('115');
    expect(fromStroops(p.fee)).toBe('5');
    expect(p.maxAmount).toBe(p.lpRepayment);
  });
  it('parts always sum to V for many random V', () => {
    for (let i = 0; i < 5000; i++) {
      const v = BigInt(Math.floor(Math.random() * 2 ** 52)) * BigInt(1 + (i % 1000)) + 1n;
      const p = computePayouts(v);
      expect(settlementTotal(p)).toBe(v);
      expect(p.rebate).toBeGreaterThanOrEqual(0n);
    }
  });
  it('toStroops/fromStroops round-trip and reject floats', () => {
    expect(toStroops('1.2345678')).toBe(12_345_678n);
    expect(fromStroops(12_345_678n)).toBe('1.2345678');
    expect(() => toStroops(1.5)).toThrow();
    expect(() => toStroops('1.12345678')).toThrow();
  });
});
