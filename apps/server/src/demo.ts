/**
 * Demo orchestrator: one invoice at a time, driven through the real Noir contracts on Testnet.
 *
 *   tokenize -> fund (LP) -> depart -> [agent ADVANCE] -> voyage -> berth + attestation
 *   -> Velo checkout -> verified payment.succeeded -> treasury funds escrow (PAID)
 *   -> guardrail probe (over-cap payout refused) -> [agent SETTLE] -> SETTLED
 *
 * Chain calls go through ONE shared NoirAgentClient and are serialised (shared Testnet accounts).
 * The agent re-evaluates after every event and decides on its own; the executor re-checks everything.
 */
import { createHash, randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  NoirAgentClient,
  defaultRecovery,
  execute,
  horizonXlmBalance,
  keypairSigner,
  runDefaultRecovery,
  runGuardrail,
  type AgentDecision,
  type ExecutionResult,
  type ExecutorContext,
  type NoirSigner,
  type Role,
} from "@noirxvelo/agent";
import { SEED_WAYBILL, canonicalJson, computePayouts, fromStroops, invoiceHash, toStroops } from "@noirxvelo/shared";
import { decide, type Facts } from "./agent.js";
import { env, missingChainEnv } from "./env.js";
import { CEBU, TOTAL_TICKS, berthTicksFrom, isBerthed, isUnderway, makeTick, type Tick } from "./telemetry.js";
import {
  WebhookRejected,
  createCheckout,
  signSimulatedDelivery,
  usingRealWebhookSecret,
  veloCheckoutConfigured,
  verifyWebhook,
  type CheckoutSession,
  type VerifiedEvent,
} from "./velo.js";

export type Status = "DRAFT" | "TOKENIZED" | "FUNDED" | "ADVANCED" | "IN_TRANSIT" | "BERTHED" | "PAID" | "SETTLED" | "HOLD" | "DEFAULT";
type Wallet = "TREASURY" | "SHIPOWNER" | "LP" | "AGENT" | "DEBTOR";

export interface TxRow {
  label: string;
  role: string;
  hash: string;
  url: string;
  at: string;
}

export interface Attestation {
  record: Record<string, string>;
  canonical: string;
  sha256: string;
  signature: string;
  signer: string;
  scheme: string;
}

export interface DecisionRow {
  id: string;
  at: string;
  decision: string;
  requested: string;
  ok: boolean;
  reason: string;
  engine: string;
  refusal: string | null;
  detail: string | null;
  proposal: AgentDecision | null;
  payouts: { role: string; xlm: string }[];
  txs: { step: string; role: string; xlm: string; hash: string; url: string }[];
  finalEscrowXlm: string | null;
  attestation: Attestation | null;
  extra: unknown;
}

export interface LogRow {
  at: string;
  level: "info" | "ok" | "warn" | "error";
  text: string;
}

export interface DemoState {
  run: number;
  status: Status;
  holdFrom: Status | null;
  invoice: {
    id: string;
    hash: string | null;
    waybill: Record<string, string>;
    faceXlm: string;
    facePhp: string;
    payouts: { advance: string; yield: string; lpRepayment: string; fee: string; rebate: string; maxAmount: string };
    policyExpiresAt: string | null;
  };
  escrowXlm: string | null;
  balances: Record<Wallet, string | null>;
  addresses: Record<Wallet, string | null>;
  voyage: { running: boolean; ticks: Tick[]; latest: Tick | null; berthed: boolean; totalTicks: number };
  attestation: Attestation | null;
  checkout: CheckoutSession | null;
  payment: { verified: boolean; eventId: string; deliveryId: string; amountXlm: string; amountMatches: boolean; verifiedBy: string; simulated: boolean; at: string; raw: unknown } | null;
  guardrail: unknown;
  recovery: unknown;
  decisions: DecisionRow[];
  txs: TxRow[];
  log: LogRow[];
  busy: string | null;
  autopilot: boolean;
  error: string | null;
  config: { chainReady: boolean; missing: string[]; veloCheckout: boolean; realWebhookSecret: boolean; llm: boolean; tickMs: number };
  updatedAt: string;
}

const V = toStroops("1000"); // demo: PHP 1,000,000 at 1 XLM = PHP 1,000
const PAYOUTS = computePayouts(V);
const TICK_MS = Number(env("DEMO_TICK_MS") ?? 1800);
const xlm = (s: bigint) => fromStroops(s);
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- wallets ----------
const pub = (r: Wallet) => env(`${r}_PUBLIC`) ?? null;
let signers: Record<"AGENT" | Role, NoirSigner> | null = null;
function getSigners(): Record<"AGENT" | Role, NoirSigner> {
  if (signers) return signers;
  const miss = missingChainEnv();
  if (miss.length) throw new Error(`Missing wallet env: ${miss.join(", ")}. Run npm run provision.`);
  signers = {
    AGENT: keypairSigner(env("AGENT_SECRET")!),
    SHIPOWNER: keypairSigner(env("SHIPOWNER_SECRET")!),
    LP: keypairSigner(env("LP_SECRET")!),
    TREASURY: keypairSigner(env("TREASURY_SECRET")!),
  };
  return signers;
}

let client: NoirAgentClient | null = null;
const getClient = () => (client ??= new NoirAgentClient());

// ---------- state ----------
let runCounter = 0;
let state: DemoState = freshState();
const listeners = new Set<(s: DemoState) => void>();
let voyageToken = 0;
let fastForward = false;
const decided = new Set<string>();
const seenDeliveries = new Set<string>();

function freshState(): DemoState {
  runCounter += 1;
  const id = `INV-2026-${String(runCounter).padStart(3, "0")}`;
  const miss = missingChainEnv();
  return {
    run: runCounter,
    status: "DRAFT",
    holdFrom: null,
    invoice: {
      id,
      hash: null,
      waybill: { ...SEED_WAYBILL, invoice_id: id, waybill_no: `VMP-2026-${String(runCounter).padStart(4, "0")}` },
      faceXlm: xlm(V),
      facePhp: "1000000",
      payouts: {
        advance: xlm(PAYOUTS.advance),
        yield: xlm(PAYOUTS.yield),
        lpRepayment: xlm(PAYOUTS.lpRepayment),
        fee: xlm(PAYOUTS.fee),
        rebate: xlm(PAYOUTS.rebate),
        maxAmount: xlm(PAYOUTS.maxAmount),
      },
      policyExpiresAt: null,
    },
    escrowXlm: null,
    balances: { TREASURY: null, SHIPOWNER: null, LP: null, AGENT: null, DEBTOR: null },
    addresses: { TREASURY: pub("TREASURY"), SHIPOWNER: pub("SHIPOWNER"), LP: pub("LP"), AGENT: pub("AGENT"), DEBTOR: pub("DEBTOR") },
    voyage: { running: false, ticks: [], latest: null, berthed: false, totalTicks: TOTAL_TICKS },
    attestation: null,
    checkout: null,
    payment: null,
    guardrail: null,
    recovery: null,
    decisions: [],
    txs: [],
    log: [{ at: now(), level: "info", text: `New invoice ${id} drafted for ${SEED_WAYBILL.vessel} (${SEED_WAYBILL.route}).` }],
    busy: null,
    autopilot: false,
    error: null,
    config: {
      chainReady: miss.length === 0,
      missing: miss,
      veloCheckout: veloCheckoutConfigured(),
      realWebhookSecret: usingRealWebhookSecret(),
      llm: !!env("LLM_API_KEY"),
      tickMs: TICK_MS,
    },
    updatedAt: now(),
  };
}

export const getState = (): DemoState => state;
export function subscribe(fn: (s: DemoState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(): void {
  state.updatedAt = now();
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {
      /* a broken listener must not stop the demo */
    }
  }
}
function log(level: LogRow["level"], text: string): void {
  state.log.push({ at: now(), level, text });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  emit();
}
function setStatus(s: Status): void {
  if (state.status !== s) {
    state.status = s;
    log("info", `Status → ${s}`);
  }
}
function addTx(label: string, role: string, t: { hash: string; explorerUrl: string }): void {
  state.txs.push({ label, role, hash: t.hash, url: t.explorerUrl, at: now() });
  log("ok", `${label}: ${t.hash.slice(0, 10)}…`);
}

// ---------- serial chain queue ----------
let chainQueue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chainQueue.then(fn, fn);
  chainQueue = p.catch(() => undefined);
  return p;
}

async function refreshBalances(): Promise<void> {
  const wallets: Wallet[] = ["TREASURY", "SHIPOWNER", "LP", "AGENT", "DEBTOR"];
  await Promise.all(
    wallets.map(async (w) => {
      const a = state.addresses[w];
      if (!a) return;
      try {
        state.balances[w] = xlm(await horizonXlmBalance(a));
      } catch {
        /* keep the last value */
      }
    }),
  );
  if (state.invoice.hash && state.config.chainReady) {
    try {
      state.escrowXlm = xlm(await getClient().balanceOf(state.invoice.hash));
    } catch {
      /* keep the last value */
    }
  }
  emit();
}

// ---------- action wrapper ----------
export class BusyError extends Error {
  constructor(readonly busyWith: string) {
    super(`Busy: ${busyWith}`);
  }
}
export class StepError extends Error {}

async function action<T>(name: string, fn: () => Promise<T>, { allowWhenBusy = false } = {}): Promise<T> {
  if (state.busy && !allowWhenBusy) throw new BusyError(state.busy);
  const owner = !state.busy;
  if (owner) state.busy = name;
  state.error = null;
  emit();
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    state.error = `${name}: ${msg}`;
    log("error", `${name} failed: ${msg}`);
    throw e;
  } finally {
    if (owner) state.busy = null;
    emit();
  }
}

function requireChain(): void {
  if (!state.config.chainReady) throw new StepError(`Chain wallets not configured (${state.config.missing.join(", ")}).`);
}
function requireStatus(...ok: Status[]): void {
  if (!ok.includes(state.status)) throw new StepError(`Not allowed in status ${state.status} (needs ${ok.join(" or ")}).`);
}

// ---------- steps ----------
export function tokenize() {
  return action("Tokenize & register", async () => {
    requireChain();
    requireStatus("DRAFT");
    const s = getSigners();
    const agentPub = s.AGENT.publicKey;
    // Unique per run: the registry rejects a hash that is already registered (spike S3).
    const waybill = { ...state.invoice.waybill, run_nonce: randomBytes(8).toString("hex") };
    const hash = invoiceHash(waybill);
    state.invoice.waybill = waybill;
    state.invoice.hash = hash;
    log("info", `Waybill hashed (sha256 canonical JSON): ${hash.slice(0, 16)}…`);
    const expires = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    addTx("device_registry.register (invoice device)", "TREASURY", await serial(() => getClient().registerDevice(s.TREASURY, hash, agentPub)));
    addTx(
      `agent_registry.register_agent (cap ${xlm(PAYOUTS.maxAmount)} XLM)`,
      "TREASURY",
      await serial(() => getClient().registerAgent(s.TREASURY, hash, agentPub, PAYOUTS.maxAmount, undefined, expires)),
    );
    state.invoice.policyExpiresAt = expires.toISOString();
    setStatus("TOKENIZED");
    await refreshBalances();
  });
}

export function fund() {
  return action("Fund 85% advance", async () => {
    requireChain();
    requireStatus("TOKENIZED");
    const s = getSigners();
    addTx(`payment_escrow.fund_escrow (LP ${xlm(PAYOUTS.advance)} XLM)`, "LP", await serial(() => getClient().fundEscrow(s.LP, state.invoice.hash!, PAYOUTS.advance)));
    setStatus("FUNDED");
    await refreshBalances();
  });
}

function facts(): Facts {
  const ticks = state.voyage.ticks;
  return {
    invoiceId: state.invoice.id,
    faceValue: V,
    status: state.status,
    escrowFunded: true,
    vesselUnderway: isUnderway(state.voyage.latest ?? undefined) || (state.voyage.running && ticks.some((t) => isUnderway(t))),
    berthed: state.voyage.berthed,
    paymentVerified: !!state.payment?.verified,
    paymentAmountMatches: !!state.payment?.amountMatches,
    vessel: SEED_WAYBILL.vessel,
    port: CEBU.name,
  };
}

function execContext(execState: string): ExecutorContext {
  const s = getSigners();
  return {
    client: getClient(),
    invoice: { id: state.invoice.id, state: execState, faceValue: V },
    deviceHash: state.invoice.hash!,
    addresses: { SHIPOWNER: s.SHIPOWNER.publicKey, LP: s.LP.publicKey, TREASURY: s.TREASURY.publicKey },
    signers: s,
    gates: {
      hashRegisteredByUs: !!state.invoice.hash,
      vesselUnderway: facts().vesselUnderway,
      webhookVerified: !!state.payment?.verified,
      webhookAmount: state.payment ? toStroops(state.payment.amountXlm) : undefined,
      berthingAttestation: !!state.attestation,
    },
  };
}

function recordDecision(proposal: AgentDecision | null, engine: string, r: ExecutionResult | null, extra: Partial<DecisionRow> = {}): DecisionRow {
  const row: DecisionRow = {
    id: `dec_${state.decisions.length + 1}_${randomBytes(3).toString("hex")}`,
    at: now(),
    decision: r?.decision ?? proposal?.decision ?? "HOLD",
    requested: r?.requested ?? proposal?.decision ?? "HOLD",
    ok: r?.ok ?? true,
    reason: proposal?.reason ?? r?.reason ?? "",
    engine,
    refusal: r?.refusal ?? null,
    detail: r?.failure?.detail ?? null,
    proposal,
    payouts: (proposal?.payouts ?? []).map((p) => ({ role: p.role, xlm: xlm(BigInt(p.amountStroops)) })),
    txs: (r?.steps ?? []).map((st) => ({ step: st.step, role: st.role, xlm: xlm(st.amount), hash: st.hash, url: st.explorerUrl })),
    finalEscrowXlm: r?.finalEscrowBalance == null ? null : xlm(r.finalEscrowBalance),
    attestation: null,
    extra: null,
    ...extra,
  };
  state.decisions.push(row);
  for (const t of row.txs) state.txs.push({ label: `payment_escrow.${t.step === "authorize" ? "authorize" : "claim"} (${t.role}${t.step === "authorize" ? ` ${t.xlm} XLM` : ""})`, role: t.step === "authorize" ? "AGENT" : t.role, hash: t.hash, url: t.url, at: row.at });
  emit();
  return row;
}

/** The agent looks at the facts and acts if a decision is due. Safe to call often. */
async function agentStep(): Promise<void> {
  if (!state.config.chainReady || !state.invoice.hash) return;
  const f = facts();
  const prop = await decide(f);
  if (!prop) return;
  const key = `${state.run}:${prop.decision.decision}:${state.status}`;
  if (decided.has(key)) return;
  decided.add(key);
  const kind = prop.decision.decision;
  log("info", `Agent decided ${kind} (${prop.engine}). Executor checking gates, amounts and policy…`);
  if (kind === "HOLD") {
    recordDecision(prop.decision, prop.engine, null);
    return;
  }
  const run = state.run;
  const execState = kind === "ADVANCE" ? "FUNDED" : "PAID";
  const result = await serial(() => execute(prop.decision, execContext(execState)));
  if (state.run !== run) return; // demo was reset while the chain call was in flight
  recordDecision(prop.decision, prop.engine, result);
  if (result.ok && result.decision === kind) {
    if (kind === "ADVANCE") {
      setStatus("ADVANCED");
      log("ok", `Advance of ${xlm(PAYOUTS.advance)} XLM (₱850,000) claimed by the shipowner.`);
    } else {
      setStatus("SETTLED");
      log("ok", `Settled: LP ${xlm(PAYOUTS.lpRepayment)}, shipowner ${xlm(PAYOUTS.rebate)}, treasury ${xlm(PAYOUTS.fee)} XLM. Escrow ${result.finalEscrowBalance == null ? "?" : xlm(result.finalEscrowBalance)} XLM.`);
    }
  } else {
    state.holdFrom = state.status;
    setStatus("HOLD");
    log("warn", `Executor forced HOLD: ${result.refusal ?? result.reason}${result.failure?.detail ? ` (${result.failure.detail})` : ""}.`);
  }
  await refreshBalances();
}

// ---------- voyage ----------
function signAttestation(t: Tick): Attestation {
  const record = {
    invoiceId: state.invoice.id,
    vesselMMSI: SEED_WAYBILL.vessel_mmsi,
    destinationPort: "CEBU_BASEPORT",
    berthTimestamp: t.at,
    lat: t.lat.toFixed(5),
    lng: t.lng.toFixed(5),
    sogKnots: t.sog.toFixed(1),
    rule: "inside 800 m Cebu geofence, SOG <= 0.5 kn for 3 consecutive ticks",
  };
  const canonical = canonicalJson(record);
  const sha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  const secret = env("AGENT_SECRET");
  const kp = secret ? Keypair.fromSecret(secret) : null;
  return {
    record,
    canonical,
    sha256,
    signature: kp ? kp.sign(Buffer.from(sha256, "hex")).toString("base64") : "unsigned (AGENT_SECRET missing)",
    signer: kp?.publicKey() ?? "n/a",
    scheme: "ed25519 over sha256(canonical JSON), agent key",
  };
}

async function onTick(t: Tick): Promise<void> {
  state.voyage.ticks.push(t);
  if (state.voyage.ticks.length > 60) state.voyage.ticks.shift();
  state.voyage.latest = t;
  if (state.status === "ADVANCED" && isUnderway(t)) setStatus("IN_TRANSIT");
  emit();
  const run = state.run;
  await agentStep(); // ADVANCE fires on the first underway tick
  if (state.run !== run) return;

  if (!state.voyage.berthed && isBerthed(state.voyage.ticks)) {
    state.voyage.berthed = true;
    state.attestation = signAttestation(t);
    log("ok", `Berthing detected at ${CEBU.name}. Attestation signed: ${state.attestation.sha256.slice(0, 16)}…`);
    if (state.status === "ADVANCED" || state.status === "IN_TRANSIT") setStatus("BERTHED");
    recordDecision(null, "berthing-detector", null, {
      decision: "BERTHED",
      requested: "BERTHED",
      reason: `${SEED_WAYBILL.vessel} inside the ${CEBU.radiusM} m Port of Cebu geofence at ≤0.5 kn for 3 ticks. Proof of delivery signed by the agent.`,
      attestation: state.attestation,
    });
    await progressPayment();
  }
}

async function voyageLoop(token: number): Promise<void> {
  let seq = 0;
  while (token === voyageToken && seq < TOTAL_TICKS) {
    if (fastForward && seq >= 2) {
      fastForward = false;
      const jump = berthTicksFrom(seq);
      log("warn", "Fast-forward: vessel jumped to the Cebu quay.");
      for (const s of jump) {
        if (token !== voyageToken) return;
        await onTick(makeTick(s));
        await sleep(300);
      }
      break;
    }
    await onTick(makeTick(seq));
    seq += 1;
    if (seq < TOTAL_TICKS) await sleep(TICK_MS);
  }
  if (token === voyageToken) {
    state.voyage.running = false;
    emit();
  }
}

let voyagePromise: Promise<void> = Promise.resolve();
export function depart() {
  return action("Depart Manila", async () => {
    requireChain();
    requireStatus("FUNDED");
    if (state.voyage.running) throw new StepError("Voyage already running.");
    state.voyage.running = true;
    log("info", `${SEED_WAYBILL.vessel} departing ${SEED_WAYBILL.origin}. AIS simulator streaming every ${TICK_MS} ms.`);
    const token = ++voyageToken;
    voyagePromise = voyageLoop(token).catch((e) => log("error", `voyage: ${e instanceof Error ? e.message : e}`));
  });
}

export function fastForwardVoyage() {
  return action(
    "Fast-forward",
    async () => {
      if (!state.voyage.running) {
        if (state.status === "FUNDED") {
          fastForward = true;
          state.voyage.running = true;
          const token = ++voyageToken;
          voyagePromise = voyageLoop(token).catch((e) => log("error", `voyage: ${e instanceof Error ? e.message : e}`));
          return;
        }
        throw new StepError("Nothing to fast-forward (voyage not running).");
      }
      fastForward = true;
    },
    { allowWhenBusy: true },
  );
}

// ---------- payment ----------
export function checkout() {
  return action("Create Velo checkout", async () => {
    if (state.checkout) return state.checkout;
    if (state.status === "DRAFT") throw new StepError("Tokenize the invoice first.");
    state.checkout = await createCheckout({
      invoiceId: state.invoice.id,
      amountXlm: xlm(V),
      description: `Freight invoice ${state.invoice.id} (Manila → Cebu), ${SEED_WAYBILL.vessel}`,
    });
    log(state.checkout.simulated ? "warn" : "ok", state.checkout.simulated ? `Checkout simulated (no VELO_API_KEY): ${state.checkout.id}` : `Velo checkout session ${state.checkout.id} created for ${xlm(V)} XLM.`);
    return state.checkout;
  });
}

/** Velo webhook entry point. Verifies, de-duplicates, matches the session, then records the payment. */
export async function receiveWebhook(raw: string, signature: string | null, deliveryId: string | null, simulated = false): Promise<{ status: number; body: unknown }> {
  let ev: VerifiedEvent;
  try {
    ev = await verifyWebhook(raw, signature);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("error", `Webhook rejected: ${msg}`);
    return { status: e instanceof WebhookRejected ? e.status : 400, body: { ok: false, error: msg } };
  }
  const dedupe = deliveryId ?? ev.id;
  if (dedupe && seenDeliveries.has(dedupe)) {
    log("warn", `Duplicate webhook delivery ${dedupe} ignored.`);
    return { status: 200, body: { ok: true, duplicate: true } };
  }
  if (dedupe) seenDeliveries.add(dedupe);
  if (ev.type !== "payment.succeeded" || !ev.paymentIntent) {
    log("info", `Webhook ${ev.type} verified (no action).`);
    return { status: 200, body: { ok: true, ignored: ev.type } };
  }
  const pi = ev.paymentIntent;
  if (!state.checkout || pi.id !== state.checkout.id) {
    log("warn", `payment.succeeded for unknown intent ${pi.id} ignored.`);
    return { status: 200, body: { ok: true, ignored: "unknown payment intent" } };
  }
  let amountMatches = false;
  try {
    amountMatches = toStroops(String(pi.amount)) === V;
  } catch {
    amountMatches = false;
  }
  state.payment = {
    verified: true,
    eventId: ev.id,
    deliveryId: dedupe ?? "",
    amountXlm: String(pi.amount),
    amountMatches,
    verifiedBy: ev.verifiedBy,
    simulated,
    at: now(),
    raw: ev.raw,
  };
  log(amountMatches ? "ok" : "warn", `Velo payment.succeeded verified (${ev.verifiedBy}) for ${pi.amount} XLM${amountMatches ? "" : " — amount does not match the invoice!"}.`);
  void progressPayment().catch((e) => log("error", `settlement: ${e instanceof Error ? e.message : e}`));
  return { status: 200, body: { ok: true } };
}

let paymentInFlight: Promise<void> | null = null;
/** Once berthed and paid: treasury funds the escrow with the debtor's money, guardrail probe, then the agent settles. */
function progressPayment(): Promise<void> {
  if (paymentInFlight) return paymentInFlight;
  if (!state.payment?.verified || !state.voyage.berthed || state.status !== "BERTHED") return Promise.resolve();
  paymentInFlight = (async () => {
    try {
      const s = getSigners();
      const run = state.run;
      if (!state.payment!.amountMatches) {
        state.status = "PAID";
        await agentStep(); // HOLD with reason
        return;
      }
      addTx(`payment_escrow.fund_escrow (Treasury ${xlm(V)} XLM from Velo checkout)`, "TREASURY", await serial(() => getClient().fundEscrow(s.TREASURY, state.invoice.hash!, V)));
      if (state.run !== run) return;
      setStatus("PAID");
      await refreshBalances();
      await guardrailProbe("Agent pre-settlement self-check");
      await agentStep(); // SETTLE
    } finally {
      paymentInFlight = null;
    }
  })();
  return paymentInFlight;
}

export function simulateWebhook() {
  return action("Simulate Velo webhook", async () => {
    if (state.status === "DRAFT") throw new StepError("Tokenize the invoice first.");
    if (!state.checkout) {
      state.checkout = await createCheckout({ invoiceId: state.invoice.id, amountXlm: xlm(V), description: `Freight invoice ${state.invoice.id}` });
    }
    const d = signSimulatedDelivery({ id: state.checkout.id, amount: xlm(V), asset: state.checkout.asset, description: `Freight invoice ${state.invoice.id}` });
    log("info", `Simulated payment.succeeded signed (HMAC-SHA256) and posted to /api/webhooks/velo.`);
    const r = await receiveWebhook(d.body, d.signature, d.deliveryId, true);
    if (r.status !== 200) throw new StepError(`webhook returned ${r.status}`);
    if (paymentInFlight) await paymentInFlight;
  });
}

// ---------- guardrail ----------
async function guardrailProbe(label: string): Promise<void> {
  if (!state.invoice.hash) return;
  const s = getSigners();
  log("info", `${label}: agent attempts a single ${xlm(V)} XLM payout against its ${xlm(PAYOUTS.maxAmount)} XLM cap…`);
  const r = await serial(() =>
    runGuardrail({ client: getClient(), deviceHash: state.invoice.hash!, agent: s.AGENT, merchant: s.SHIPOWNER.publicKey, capAmount: PAYOUTS.maxAmount, attemptAmount: V }),
  );
  const json = JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  state.guardrail = { ...json, ranAt: now() };
  recordDecision(null, "noir-policy", null, {
    decision: r.unexpectedSuccess ? "GUARDRAIL_FAILED" : "REFUSED",
    requested: "PAY 1000 XLM",
    ok: !r.unexpectedSuccess,
    reason: r.summary,
    refusal: r.checkPayment.ok ? null : r.checkPayment.reason,
    detail: r.sdkError ? `${r.sdkError.errorName ?? r.sdkError.name}${r.sdkError.code != null ? ` #${r.sdkError.code}` : ""}` : null,
    payouts: [{ role: "SHIPOWNER", xlm: xlm(V) }],
    extra: json,
  });
  log(r.unexpectedSuccess ? "error" : "ok", r.summary);
}

export function guardrail() {
  return action("Guardrail demo", async () => {
    requireChain();
    if (!state.invoice.hash) throw new StepError("Tokenize the invoice first.");
    await guardrailProbe("Guardrail demo");
  });
}

// ---------- default ----------
export function simulateDefault() {
  return action("Simulate default", async () => {
    requireChain();
    requireStatus("FUNDED", "ADVANCED", "IN_TRANSIT", "BERTHED", "HOLD");
    voyageToken++;
    state.voyage.running = false;
    const s = getSigners();
    const decision: AgentDecision = { invoiceId: state.invoice.id, decision: "DEFAULT", reason: "Due date + grace passed (simulated clock) with no verified payment. Ops may recover the escrow.", payouts: [] };
    const ctx: ExecutorContext = {
      ...execContext(state.status === "HOLD" ? (state.holdFrom ?? "FUNDED") : state.status),
      gates: { ...execContext("FUNDED").gates, webhookVerified: false, dueDatePlusGracePassed: true },
      recovery: () => defaultRecovery({ client: getClient(), ownerSigner: s.TREASURY, deviceHash: state.invoice.hash!, agent: s.AGENT }),
    };
    const result = await serial(() => execute(decision, ctx));
    recordDecision(decision, "rules", result);
    if (!(result.ok && result.decision === "DEFAULT")) throw new StepError(`executor refused DEFAULT: ${result.refusal}`);
    setStatus("DEFAULT");
    const rec = await serial(() => runDefaultRecovery(result, ctx));
    rec.txs.forEach((t, i) => addTx(`default recovery tx ${i + 1}/${rec.txs.length} (revoke_agent + sweep_on_revoke → Treasury)`, "TREASURY", t));
    state.recovery = JSON.parse(JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    log("ok", `Recovery: escrow ${xlm(rec.escrowBefore)} → ${xlm(rec.escrowAfter)} XLM swept to Treasury; revoked agent now refused (${rec.checkAfterRevoke}).`);
    await refreshBalances();
  });
}

// ---------- reset / run demo ----------
export function reset() {
  return action("Reset", async () => {
    voyageToken++;
    fastForward = false;
    await chainQueue.catch(() => undefined);
    const prevLog = state.log.slice(-3);
    state = freshState();
    state.busy = "Reset";
    state.log.unshift(...prevLog.map((l) => ({ ...l, text: `(previous run) ${l.text}` })));
    await refreshBalances();
  });
}

export function runDemo() {
  return action("Run Demo", async () => {
    requireChain();
    state.autopilot = true;
    try {
      if (state.status !== "DRAFT") {
        voyageToken++;
        await chainQueue.catch(() => undefined);
        const keep = state.log.slice(-2);
        const busy = state.busy;
        state = freshState();
        state.busy = busy;
        state.autopilot = true;
        state.log.unshift(...keep);
        emit();
      }
      log("info", "▶ Run Demo: full loop on Stellar Testnet.");
      await inner(tokenize);
      await sleep(800);
      await inner(fund);
      await sleep(800);
      await inner(depart);
      await voyagePromise;
      if (!state.voyage.berthed) throw new StepError("Vessel did not berth.");
      await inner(checkout);
      await sleep(1200);
      await inner(simulateWebhook);
      log(state.status === "SETTLED" ? "ok" : "warn", `■ Run Demo finished with status ${state.status}.`);
    } finally {
      state.autopilot = false;
    }
  });
}

/** Run a step from inside Run Demo (re-uses the outer busy lock). */
async function inner(step: () => Promise<unknown>): Promise<void> {
  const outer = state.busy;
  state.busy = null;
  try {
    await step();
  } finally {
    state.busy = outer;
    emit();
  }
}

export async function init(): Promise<void> {
  if (state.config.chainReady) {
    try {
      getSigners();
    } catch (e) {
      state.config.chainReady = false;
      state.error = e instanceof Error ? e.message : String(e);
    }
  } else {
    log("warn", `Wallets missing (${state.config.missing.join(", ")}). UI runs read-only until they are set.`);
  }
  if (!state.config.realWebhookSecret) log("warn", "VELO_WEBHOOK_SECRET not set: only simulated (self-signed) webhooks will verify.");
  await refreshBalances();
}
