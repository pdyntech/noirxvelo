import { invoiceHash } from './canonical.js';
import { phpToStroops } from './math.js';
import type { Store } from './store.js';
import type { Invoice } from './types.js';

/** Canonical waybill for the demo shipment. Money is a decimal string (never a float). */
export const SEED_WAYBILL = {
  waybill_no: 'VMP-2026-0001',
  vessel: 'MV VisMin Pioneer',
  vessel_mmsi: '548123456',
  shipper: 'MV VisMin Pioneer Shipping',
  debtor: 'Isla Beverages Corp.',
  origin: 'Manila South Harbor',
  destination: 'Port of Cebu',
  route: 'Manila South Harbor -> Port of Cebu',
  face_value_php: '1000000',
  currency: 'PHP',
  terms: 'Net-60',
  issued: '2026-11-06',
  due_date: '2027-01-05',
} as const;

export const SEED_INVOICE_ID = 'inv_seed_001';

export function seedInvoice(): Invoice {
  const php = BigInt(SEED_WAYBILL.face_value_php);
  return {
    id: SEED_INVOICE_ID,
    invoice_hash: invoiceHash(SEED_WAYBILL),
    face_value_php: php,
    face_value_xlm: phpToStroops(php), // 1000 XLM = 10_000_000_000 stroops
    status: 'REGISTERED',
    due_date: SEED_WAYBILL.due_date,
    vessel_mmsi: SEED_WAYBILL.vessel_mmsi,
    route: SEED_WAYBILL.route,
  };
}

/** Idempotent: does nothing if the seed invoice is already present (e.g. restored from disk). */
export function loadSeed(store: Store): Invoice {
  const existing = store.getInvoiceByHash(invoiceHash(SEED_WAYBILL));
  return existing ?? store.addInvoice(seedInvoice());
}
