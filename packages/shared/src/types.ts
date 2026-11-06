/** Amounts are bigint stroops. Timestamps are ISO-8601 strings. */

export type InvoiceStatus =
  | 'REGISTERED'
  | 'FUNDED'
  | 'ADVANCED'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'PAID'
  | 'SETTLED'
  | 'HOLD';

export interface Invoice {
  id: string;
  invoice_hash: string;
  /** Whole pesos (demo). */
  face_value_php: bigint;
  /** Stroops. */
  face_value_xlm: bigint;
  status: InvoiceStatus;
  due_date: string;
  vessel_mmsi: string;
  route: string;
}

export interface Device {
  device_hash: string;
  owner_address: string;
  agent_address: string;
  registered_at: string;
}

export type DecisionKind = 'ADVANCE' | 'SETTLE' | 'HOLD';

export interface Payout {
  to: string;
  amount: bigint;
}

export interface Decision {
  id: string;
  invoice_id: string;
  decision: DecisionKind;
  reason: string;
  payouts_json: Payout[];
  nonce: string | null;
  tx_hash: string | null;
  created_at: string;
}

export interface TelemetryTick {
  id: string;
  invoice_id: string;
  lat: number;
  lng: number;
  sog_knots: number;
  cog_deg: number;
  timestamp: string;
}

export interface WebhookEvent {
  event_id: string;
  event_type: string;
  payload_json: unknown;
  verified: boolean;
  received_at: string;
}
