import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision, Device, Invoice, TelemetryTick, WebhookEvent } from './types.js';

export class DuplicateInvoiceError extends Error {
  readonly invoice_hash: string;
  constructor(invoice_hash: string) {
    super(`Duplicate invoice_hash: ${invoice_hash}`);
    this.name = 'DuplicateInvoiceError';
    this.invoice_hash = invoice_hash;
  }
}

export interface Store {
  addInvoice(inv: Invoice): Invoice;
  getInvoice(id: string): Invoice | undefined;
  getInvoiceByHash(hash: string): Invoice | undefined;
  listInvoices(): Invoice[];
  updateInvoice(id: string, patch: Partial<Omit<Invoice, 'id' | 'invoice_hash'>>): Invoice;

  upsertDevice(d: Device): Device;
  getDevice(device_hash: string): Device | undefined;
  listDevices(): Device[];

  addDecision(d: Decision): Decision;
  listDecisions(invoice_id?: string): Decision[];

  addTick(t: TelemetryTick): TelemetryTick;
  listTicks(invoice_id: string): TelemetryTick[];

  /** Returns { inserted: false } and keeps the original if event_id was already seen. */
  addWebhook(e: WebhookEvent): { inserted: boolean; event: WebhookEvent };
  getWebhook(event_id: string): WebhookEvent | undefined;
  listWebhooks(): WebhookEvent[];
}

interface State {
  invoices: Invoice[];
  devices: Device[];
  decisions: Decision[];
  ticks: TelemetryTick[];
  webhooks: WebhookEvent[];
}

const empty = (): State => ({ invoices: [], devices: [], decisions: [], ticks: [], webhooks: [] });

/** JSON with bigint round-trip via {"$bigint":"123"}. */
const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v);
const reviver = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '$bigint' in v ? BigInt((v as { $bigint: string }).$bigint) : v;

export interface StoreOptions {
  /** JSON file path for persistence. Defaults to env NOIRXVELO_DATA_FILE; none = memory only. */
  filePath?: string | null;
}

export class MemoryStore implements Store {
  private s: State = empty();
  private readonly file: string | null;

  constructor(opts: StoreOptions = {}) {
    this.file = opts.filePath === undefined ? (process.env.NOIRXVELO_DATA_FILE || null) : opts.filePath;
    if (this.file && existsSync(this.file)) {
      this.s = { ...empty(), ...JSON.parse(readFileSync(this.file, 'utf8'), reviver) };
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.s, replacer));
    renameSync(tmp, this.file);
  }

  addInvoice(inv: Invoice): Invoice {
    if (this.s.invoices.some((i) => i.invoice_hash === inv.invoice_hash)) throw new DuplicateInvoiceError(inv.invoice_hash);
    if (this.s.invoices.some((i) => i.id === inv.id)) throw new Error(`Duplicate invoice id: ${inv.id}`);
    this.s.invoices.push({ ...inv });
    this.save();
    return { ...inv };
  }
  getInvoice(id: string) {
    const i = this.s.invoices.find((x) => x.id === id);
    return i && { ...i };
  }
  getInvoiceByHash(hash: string) {
    const i = this.s.invoices.find((x) => x.invoice_hash === hash);
    return i && { ...i };
  }
  listInvoices() {
    return this.s.invoices.map((i) => ({ ...i }));
  }
  updateInvoice(id: string, patch: Partial<Omit<Invoice, 'id' | 'invoice_hash'>>) {
    const i = this.s.invoices.find((x) => x.id === id);
    if (!i) throw new Error(`Invoice not found: ${id}`);
    Object.assign(i, patch);
    this.save();
    return { ...i };
  }

  upsertDevice(d: Device) {
    const idx = this.s.devices.findIndex((x) => x.device_hash === d.device_hash);
    if (idx >= 0) this.s.devices[idx] = { ...d };
    else this.s.devices.push({ ...d });
    this.save();
    return { ...d };
  }
  getDevice(h: string) {
    const d = this.s.devices.find((x) => x.device_hash === h);
    return d && { ...d };
  }
  listDevices() {
    return this.s.devices.map((d) => ({ ...d }));
  }

  addDecision(d: Decision) {
    this.s.decisions.push({ ...d });
    this.save();
    return { ...d };
  }
  listDecisions(invoice_id?: string) {
    return this.s.decisions.filter((d) => !invoice_id || d.invoice_id === invoice_id).map((d) => ({ ...d }));
  }

  addTick(t: TelemetryTick) {
    this.s.ticks.push({ ...t });
    this.save();
    return { ...t };
  }
  listTicks(invoice_id: string) {
    return this.s.ticks.filter((t) => t.invoice_id === invoice_id).map((t) => ({ ...t }));
  }

  addWebhook(e: WebhookEvent) {
    const existing = this.s.webhooks.find((w) => w.event_id === e.event_id);
    if (existing) return { inserted: false, event: { ...existing } };
    this.s.webhooks.push({ ...e });
    this.save();
    return { inserted: true, event: { ...e } };
  }
  getWebhook(id: string) {
    const w = this.s.webhooks.find((x) => x.event_id === id);
    return w && { ...w };
  }
  listWebhooks() {
    return this.s.webhooks.map((w) => ({ ...w }));
  }
}

export function createStore(opts?: StoreOptions): Store {
  return new MemoryStore(opts);
}
