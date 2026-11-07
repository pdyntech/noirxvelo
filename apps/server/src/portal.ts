/**
 * Portal invoices for signed-in users (Shipowner, Investor, Cargo owner).
 *
 * Invoices live in one shared ledger, so the roles meet each other:
 *   shipowner tokenizes -> any investor funds from the marketplace -> agent ADVANCE -> voyage -> berth
 *   -> the named cargo owner pays from their portal -> agent SETTLE.
 * Amounts use the same integer payout math as the on-chain demo (@noirxvelo/shared, 1 XLM = PHP 1,000).
 * Escrow and transfers here are simulated in memory; the live Testnet run is the /app demo.
 *
 * New accounts get a few private sample invoices so the portal is not empty. A sample's missing
 * counterparty (investor or cargo owner) is simulated and acts on its own after a short delay.
 */
import { createHash } from "node:crypto";
import { canonicalJson, computePayouts, phpToStroops, stroopsToPhp } from "@noirxvelo/shared";
import { db, save, type User } from "./db.js";
import { HttpError } from "./http.js";
import { normEmail } from "./accounts.js";

export type PState = "TOKENIZED" | "FUNDED" | "ADVANCED" | "IN_TRANSIT" | "BERTHED" | "PAID" | "SETTLED" | "HOLD";
type Contract = "device_registry" | "agent_registry" | "payment_escrow";
type PayRole = "SHIPOWNER" | "LP" | "TREASURY";

export interface LogEntry {
  at: string;
  title: string;
  text: string;
  c: Contract;
  decision?: "ADVANCE" | "SETTLE" | "HOLD";
  pay?: [PayRole, number][];
  raw?: unknown;
}

export interface PortalInvoice {
  seq: number;
  id: string;
  hash: string;
  createdAt: string;
  vessel: string;
  route: string;
  port: string;
  debtor: string;
  debtorEmail: string | null;
  ownerId: string | null;
  ownerName: string;
  funderId: string | null;
  funderName: string | null;
  face: number;
  term: number;
  state: PState;
  holdFrom: PState | null;
  /** ms epoch when the current state began; drives the automatic steps. */
  stateAt: number;
  paidAmount: number | null;
  berthAttested: boolean;
  /** Sample invoices are visible only to the account they were created for. */
  sampleFor: string | null;
  simInvestor: boolean;
  simDebtor: boolean;
  log: LogEntry[];
}

const VOYAGE_MS = Number(process.env.PORTAL_VOYAGE_MS ?? 20_000);
const ORDER: PState[] = ["TOKENIZED", "FUNDED", "ADVANCED", "IN_TRANSIT", "BERTHED", "PAID", "SETTLED"];
const TERMS = [30, 45, 60, 90];
const MAX_OPEN_PER_USER = 50;

// ---------- money ----------
export interface Money {
  adv: number;
  lp: number;
  fee: number;
  reb: number;
  cap: number;
}

export function money(face: number): Money {
  const p = computePayouts(phpToStroops(BigInt(face)));
  const php = (s: bigint) => Number(stroopsToPhp(s));
  return { adv: php(p.advance), lp: php(p.lpRepayment), fee: php(p.fee), reb: php(p.rebate), cap: php(p.maxAmount) };
}

const peso = (n: number) => "₱" + n.toLocaleString("en-US");
const xlm = (n: number) => (n / 1000).toLocaleString("en-US") + " XLM";
const stroops = (php: number) => (BigInt(php) * 10_000n).toString();

function escrowOf(i: PortalInvoice): number {
  const s = i.state === "HOLD" ? i.holdFrom : i.state;
  const m = money(i.face);
  return s === "FUNDED" ? m.adv : s === "PAID" ? i.face : 0;
}

// ---------- ledger helpers ----------
function log(i: PortalInvoice, e: Omit<LogEntry, "at">): void {
  i.log.push({ at: new Date().toISOString(), ...e });
}

function setState(i: PortalInvoice, s: PState, at = Date.now()): void {
  i.state = s;
  i.stateAt = at;
}

function nextId(): { seq: number; id: string } {
  db.seq += 1;
  return { seq: db.seq, id: `INV-${new Date().getFullYear()}-${String(db.seq).padStart(3, "0")}` };
}

interface NewInvoice {
  vessel: string;
  route: string;
  debtor: string;
  debtorEmail: string | null;
  ownerId: string | null;
  ownerName: string;
  face: number;
  term: number;
  sampleFor?: string | null;
  simInvestor?: boolean;
  simDebtor?: boolean;
}

function create(n: NewInvoice): PortalInvoice {
  const { seq, id } = nextId();
  const record = { id, vessel: n.vessel, route: n.route, debtor: n.debtor, face: String(n.face), term: n.term };
  const hash = createHash("sha256").update(canonicalJson(record)).digest("hex");
  if (db.invoices.some((x) => x.hash === hash)) throw new HttpError(409, "This invoice is already registered.");
  const i: PortalInvoice = {
    seq,
    id,
    hash,
    createdAt: new Date().toISOString(),
    vessel: n.vessel,
    route: n.route,
    port: "Port of " + n.route.split(/\s+to\s+/i)[1]!.trim(),
    debtor: n.debtor,
    debtorEmail: n.debtorEmail,
    ownerId: n.ownerId,
    ownerName: n.ownerName,
    funderId: null,
    funderName: null,
    face: n.face,
    term: n.term,
    state: "TOKENIZED",
    holdFrom: null,
    stateAt: Date.now(),
    paidAmount: null,
    berthAttested: false,
    sampleFor: n.sampleFor ?? null,
    simInvestor: n.simInvestor ?? false,
    simDebtor: n.simDebtor ?? !n.debtorEmail,
    log: [],
  };
  const m = money(n.face);
  log(i, {
    title: "Invoice tokenized",
    text: `SHA-256 ${hash.slice(0, 16)}… registered as the invoice’s ID, with an agent limit of ${xlm(m.cap)} per payment.`,
    c: "device_registry",
  });
  db.invoices.push(i);
  return i;
}

// ---------- lifecycle steps ----------
function fund(i: PortalInvoice, funderId: string | null, funderName: string): void {
  const m = money(i.face);
  i.funderId = funderId;
  i.funderName = funderName;
  log(i, { title: "Investor funded the advance", text: `${funderName} deposited ${peso(m.adv)} (${xlm(m.adv)}) into escrow.`, c: "payment_escrow" });
  setState(i, "FUNDED");
}

function hold(i: PortalInvoice, reason: string, checks: string[]): void {
  log(i, { title: "HOLD", text: reason, c: "payment_escrow", decision: "HOLD", pay: [], raw: { invoiceId: i.id, decision: "HOLD", reason, checks, payouts: [] } });
  i.holdFrom = i.state;
  setState(i, "HOLD");
}

/** The agent proposes; these code checks decide. Any failure holds the invoice and moves nothing. */
function agentAdvance(i: PortalInvoice): void {
  const m = money(i.face);
  const checks: [string, boolean][] = [
    ["invoice hash registered", /^[0-9a-f]{64}$/.test(i.hash)],
    ["investor deposit recorded", Boolean(i.funderName)],
    [`escrow covers the advance (${xlm(escrowOf(i))} ≥ ${xlm(m.adv)})`, escrowOf(i) >= m.adv],
    [`advance within the per-payment cap (${xlm(m.adv)} ≤ ${xlm(m.cap)})`, m.adv <= m.cap],
  ];
  const failed = checks.filter((c) => !c[1]).map((c) => c[0]);
  if (failed.length) return hold(i, `Advance refused: ${failed.join("; ")}.`, checks.map((c) => `${c[1] ? "pass" : "FAIL"}: ${c[0]}`));
  const reason = "The waybill hash is registered, the investor deposit is in escrow and covers the advance, and the payment is within the cap. Policy check passed.";
  const pay: [PayRole, number][] = [["SHIPOWNER", m.adv]];
  log(i, {
    title: "ADVANCE",
    text: reason,
    c: "payment_escrow",
    decision: "ADVANCE",
    pay,
    raw: { invoiceId: i.id, decision: "ADVANCE", reason, checks: checks.map((c) => `pass: ${c[0]}`), payouts: pay.map(([role, v]) => ({ role, amountStroops: stroops(v) })) },
  });
  setState(i, "ADVANCED");
}

function depart(i: PortalInvoice): void {
  const m = money(i.face);
  log(i, { title: "Vessel departed", text: `The shipowner claimed ${peso(m.adv)}. Escrow is back to 0 until the cargo owner pays.`, c: "payment_escrow" });
  setState(i, "IN_TRANSIT");
}

function berth(i: PortalInvoice): void {
  i.berthAttested = true;
  log(i, { title: `Berthed at ${i.port}`, text: "Inside the port geofence at 0.0 kn for 3 consecutive readings. Arrival attestation recorded.", c: "agent_registry" });
  setState(i, "BERTHED");
}

function pay(i: PortalInvoice, payer: string): void {
  i.paidAmount = i.face;
  log(i, { title: "Cargo owner paid", text: `${payer} paid ${peso(i.face)} through checkout. Payment verified and escrow funded.`, c: "payment_escrow" });
  setState(i, "PAID");
}

function agentSettle(i: PortalInvoice): void {
  const m = money(i.face);
  const pay: [PayRole, number][] = [
    ["LP", m.lp],
    ["SHIPOWNER", m.reb],
    ["TREASURY", m.fee],
  ];
  const total = pay.reduce((a, p) => a + p[1], 0);
  const checks: [string, boolean][] = [
    [`payment equals the invoice (${peso(i.paidAmount ?? 0)} = ${peso(i.face)})`, i.paidAmount === i.face],
    ["arrival attested", i.berthAttested],
    [`escrow holds the payment (${xlm(escrowOf(i))})`, escrowOf(i) === i.face],
    [`payouts sum to the invoice (${peso(total)})`, total === i.face],
    [`every payout within the cap of ${xlm(m.cap)}`, pay.every((p) => p[1] <= m.cap)],
  ];
  const failed = checks.filter((c) => !c[1]).map((c) => c[0]);
  if (failed.length) return hold(i, `Settlement refused: ${failed.join("; ")}.`, checks.map((c) => `${c[1] ? "pass" : "FAIL"}: ${c[0]}`));
  const reason = "Payment verified for the exact invoice amount and arrival attested. Repaying the investor, returning the reserve and taking the fee. The parts sum to the invoice value.";
  log(i, {
    title: "SETTLE",
    text: reason,
    c: "payment_escrow",
    decision: "SETTLE",
    pay,
    raw: { invoiceId: i.id, decision: "SETTLE", reason, checks: checks.map((c) => `pass: ${c[0]}`), payouts: pay.map(([role, v]) => ({ role, amountStroops: stroops(v) })) },
  });
  setState(i, "SETTLED");
}

/** One automatic step if its delay has passed. Returns true if the invoice changed. */
function autoStep(i: PortalInvoice, now: number): boolean {
  const age = now - i.stateAt;
  const due: Partial<Record<PState, [number, () => void]>> = {
    TOKENIZED: [i.simInvestor ? 8000 : Infinity, () => fund(i, null, "A simulated investor")],
    FUNDED: [1400, () => agentAdvance(i)],
    ADVANCED: [1400, () => depart(i)],
    IN_TRANSIT: [VOYAGE_MS, () => berth(i)],
    BERTHED: [i.simDebtor ? 5000 : Infinity, () => pay(i, `${i.debtor} (simulated)`)],
    PAID: [1600, () => agentSettle(i)],
  };
  const step = due[i.state];
  if (!step || age < step[0]) return false;
  step[1]();
  return true;
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const i of db.invoices) if (autoStep(i, now)) changed = true;
  if (changed) save();
}, 400).unref();

// ---------- samples for new accounts ----------
/** Push an invoice through the manual steps up to `target`, without waiting. */
function fastForward(i: PortalInvoice, target: PState, sampleFunder: string): void {
  while (ORDER.indexOf(i.state) < ORDER.indexOf(target)) {
    if (i.state === "TOKENIZED") fund(i, null, sampleFunder);
    else if (i.state === "FUNDED") agentAdvance(i);
    else if (i.state === "ADVANCED") depart(i);
    else if (i.state === "IN_TRANSIT") berth(i);
    else if (i.state === "BERTHED") pay(i, `${i.debtor} (simulated)`);
    else if (i.state === "PAID") agentSettle(i);
  }
}

type Seed = [vessel: string, route: string, debtor: string, owner: string, face: number, term: number, target: PState, voyagePct?: number];

export function seedSamples(u: User): void {
  const me = u.company || u.name;
  const sample = (s: Seed, opts: { owner: boolean; debtor: boolean; investorIsMe?: boolean; simInvestor?: boolean }) => {
    const [vessel, route, debtor, owner, face, term, target, pct] = s;
    const i = create({
      vessel,
      route,
      debtor: opts.debtor ? me : debtor,
      debtorEmail: opts.debtor ? u.email : null,
      ownerId: opts.owner ? u.id : null,
      ownerName: opts.owner ? me : owner,
      face,
      term,
      sampleFor: u.id,
      simInvestor: opts.simInvestor ?? false,
      simDebtor: !opts.debtor,
    });
    if (target !== "TOKENIZED") {
      fastForward(i, target, opts.investorIsMe ? u.name : "A simulated investor");
      if (opts.investorIsMe) i.funderId = u.id;
    }
    if (target === "IN_TRANSIT" && pct) i.stateAt = Date.now() - Math.floor(VOYAGE_MS * pct);
  };
  // Created oldest-last so the newest-first list matches the intended order.
  if (u.role === "Shipowner") {
    sample(["MV Archipelago Star", "Manila to Davao", "Isla Beverages Corp.", "", 1_500_000, 90, "SETTLED"], { owner: true, debtor: false });
    sample(["MV Mindanao Express", "Cebu to Cagayan de Oro", "Isla Beverages Corp.", "", 750_000, 45, "IN_TRANSIT", 0.55], { owner: true, debtor: false });
    sample(["MV VisMin Pioneer", "Manila to Cebu", "Isla Beverages Corp.", "", 1_000_000, 60, "TOKENIZED"], { owner: true, debtor: false, simInvestor: true });
  } else if (u.role === "Investor") {
    sample(["MV Archipelago Star", "Manila to Davao", "Isla Beverages Corp.", "Archipelago Marine", 1_500_000, 90, "SETTLED"], { owner: false, debtor: false, investorIsMe: true });
    sample(["MV VisMin Pioneer", "Manila to Cebu", "Isla Beverages Corp.", "Visayan Lines", 1_000_000, 60, "IN_TRANSIT", 0.55], { owner: false, debtor: false, investorIsMe: true });
    sample(["MV Dapitan Express", "Manila to Dumaguete", "Northern Foods Inc.", "Dapitan Marine", 1_200_000, 60, "TOKENIZED"], { owner: false, debtor: false });
    sample(["MV Samar Star", "Cebu to Tacloban", "Isla Beverages Corp.", "Samar Shipping", 600_000, 30, "TOKENIZED"], { owner: false, debtor: false });
    sample(["MV Bisaya Trader", "Manila to Iloilo", "Northern Foods Inc.", "Bisaya Lines", 900_000, 45, "TOKENIZED"], { owner: false, debtor: false });
  } else {
    sample(["MV Archipelago Star", "Manila to Davao", "", "Archipelago Marine", 1_500_000, 90, "SETTLED"], { owner: false, debtor: true });
    sample(["MV VisMin Pioneer", "Manila to Cebu", "", "Visayan Lines", 1_000_000, 60, "BERTHED"], { owner: false, debtor: true });
    sample(["MV Mindanao Express", "Cebu to Cagayan de Oro", "", "Mindanao Lines", 750_000, 45, "IN_TRANSIT", 0.55], { owner: false, debtor: true });
  }
  save();
}

// ---------- views ----------
function visible(i: PortalInvoice, u: User): boolean {
  if (i.sampleFor && i.sampleFor !== u.id) return false;
  if (u.role === "Shipowner") return i.ownerId === u.id;
  if (u.role === "Cargo owner") return i.debtorEmail === u.email;
  if (i.funderId === u.id) return true;
  return i.state === "TOKENIZED" && !i.funderName && !i.simInvestor && i.ownerId !== u.id;
}

export interface InvoiceView {
  id: string;
  hash: string;
  vessel: string;
  route: string;
  port: string;
  debtor: string;
  debtorEmail: string | null;
  owner: string;
  funder: string | null;
  face: number;
  term: number;
  state: PState;
  holdFrom: PState | null;
  prog: number;
  escrow: number;
  m: Money;
  funded: boolean;
  sample: boolean;
  simInvestor: boolean;
  simDebtor: boolean;
  log: LogEntry[];
}

function progress(i: PortalInvoice, now: number): number {
  const k = ORDER.indexOf(i.state === "HOLD" ? (i.holdFrom ?? "TOKENIZED") : i.state);
  if (k >= ORDER.indexOf("BERTHED")) return 100;
  if (i.state === "IN_TRANSIT") return Math.min(99, Math.floor(((now - i.stateAt) / VOYAGE_MS) * 100));
  return 0;
}

function view(i: PortalInvoice, u: User, now: number): InvoiceView {
  return {
    id: i.id,
    hash: i.hash,
    vessel: i.vessel,
    route: i.route,
    port: i.port,
    debtor: i.debtor,
    debtorEmail: u.role === "Shipowner" ? i.debtorEmail : null,
    owner: i.ownerName,
    funder: i.funderName,
    face: i.face,
    term: i.term,
    state: i.state,
    holdFrom: i.holdFrom,
    prog: progress(i, now),
    escrow: escrowOf(i),
    m: money(i.face),
    funded: u.role === "Investor" ? i.funderId === u.id : Boolean(i.funderName),
    sample: Boolean(i.sampleFor),
    simInvestor: i.simInvestor,
    simDebtor: i.simDebtor,
    log: i.log,
  };
}

export function portalFor(u: User): { invoices: InvoiceView[]; voyageMs: number } {
  const now = Date.now();
  const invoices = db.invoices
    .filter((i) => visible(i, u))
    .sort((a, b) => b.seq - a.seq)
    .map((i) => view(i, u, now));
  return { invoices, voyageMs: VOYAGE_MS };
}

function find(u: User, id: unknown): PortalInvoice {
  const i = db.invoices.find((x) => x.id === id);
  if (!i || !visible(i, u)) throw new HttpError(404, "Invoice not found.");
  return i;
}

// ---------- user actions ----------
export function createInvoice(u: User, b: Record<string, unknown>): InvoiceView {
  if (u.role !== "Shipowner") throw new HttpError(403, "Only shipowners can tokenize invoices.");
  const text = (v: unknown, label: string, max: number) => {
    const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
    if (!s) throw new HttpError(400, `Enter the ${label}.`);
    if (s.length > max) throw new HttpError(400, `The ${label} is too long.`);
    return s;
  };
  const vessel = text(b.vessel, "vessel", 80);
  const route = text(b.route, "route", 120);
  if (!/^.+\s+to\s+.+$/i.test(route)) throw new HttpError(400, 'Write the route like "Manila to Cebu".');
  const debtor = text(b.debtor, "cargo owner", 120);
  const debtorEmail = typeof b.debtorEmail === "string" && b.debtorEmail.trim() ? normEmail(b.debtorEmail) : null;
  if (debtorEmail === u.email) throw new HttpError(400, "The cargo owner must be a different account.");
  const face = Number(b.face);
  if (!Number.isSafeInteger(face) || face < 10_000 || face > 100_000_000) throw new HttpError(400, "Enter an invoice value between ₱10,000 and ₱100,000,000 in whole pesos.");
  const term = Number(b.term);
  if (!TERMS.includes(term)) throw new HttpError(400, "Choose Net-30, Net-45, Net-60 or Net-90.");
  const open = db.invoices.filter((i) => i.ownerId === u.id && !i.sampleFor && i.state !== "SETTLED").length;
  if (open >= MAX_OPEN_PER_USER) throw new HttpError(429, "You have too many open invoices.");
  const i = create({ vessel, route, debtor, debtorEmail, ownerId: u.id, ownerName: u.company || u.name, face, term });
  save();
  return view(i, u, Date.now());
}

export function fundInvoice(u: User, id: unknown): InvoiceView {
  if (u.role !== "Investor") throw new HttpError(403, "Only investors can fund invoices.");
  const i = find(u, id);
  if (i.state !== "TOKENIZED" || i.funderName) throw new HttpError(409, "This invoice has already been funded.");
  fund(i, u.id, u.company || u.name);
  save();
  return view(i, u, Date.now());
}

export function payInvoice(u: User, id: unknown): InvoiceView {
  if (u.role !== "Cargo owner") throw new HttpError(403, "Only the cargo owner can pay this invoice.");
  const i = find(u, id);
  if (i.state !== "BERTHED") throw new HttpError(409, i.state === "IN_TRANSIT" ? "The vessel has not arrived yet." : "This invoice is not awaiting payment.");
  pay(i, u.company || u.name);
  save();
  return view(i, u, Date.now());
}
