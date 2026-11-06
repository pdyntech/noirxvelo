/**
 * AGT-02: deterministic executor (PRD §6 principles 2, 5, 7; §8.3; §10.3; §10.7).
 * The LLM proposes an AgentDecision (roles + amounts). This code checks preconditions, recomputes
 * the amounts, maps roles to addresses from ctx, and only then touches the chain, always through
 * NoirAgentClient (which pre-checks every authorize with checkPayment and serialises per device+agent).
 * `execute` never throws: every failure becomes a HOLD that reports what already landed.
 */
import { computePayouts, settlementTotal } from "@noirxvelo/shared";
import type { NoirAgentClient, NoirSigner } from "./client.js";
import { normalizeError } from "./errors.js";
import type { DefaultRecoveryResult } from "./recovery.js";

export type Role = "SHIPOWNER" | "LP" | "TREASURY";
export type DecisionKind = "ADVANCE" | "SETTLE" | "HOLD" | "DEFAULT";

export const ROLES: readonly Role[] = ["SHIPOWNER", "LP", "TREASURY"];
const DECISIONS: readonly DecisionKind[] = ["ADVANCE", "SETTLE", "HOLD", "DEFAULT"];

export interface AgentPayout {
  role: Role;
  /** Decimal string of stroops. */
  amountStroops: string;
}

/** PRD §8.3 decision contract. */
export interface AgentDecision {
  invoiceId: string;
  decision: DecisionKind;
  reason: string;
  payouts: AgentPayout[];
}

export type ValidationResult = { ok: true; decision: AgentDecision } | { ok: false; errors: string[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function extraKeys(o: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(o).filter((k) => !allowed.includes(k));
}

/** Hand-written validator for the PRD §8.3 JSON schema (additionalProperties: false everywhere). */
export function validateDecision(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["decision must be an object"] };
  for (const k of extraKeys(input, ["invoiceId", "decision", "reason", "payouts"])) errors.push(`unexpected field "${k}"`);

  const { invoiceId, decision, reason, payouts } = input;
  if (typeof invoiceId !== "string" || !/^INV-[0-9]{4}-[0-9]{3}$/.test(invoiceId)) errors.push("invoiceId must match INV-YYYY-NNN");
  if (typeof decision !== "string" || !DECISIONS.includes(decision as DecisionKind)) errors.push("decision must be ADVANCE|SETTLE|HOLD|DEFAULT");
  if (typeof reason !== "string") errors.push("reason must be a string");
  else if (reason.length > 280) errors.push("reason must be <= 280 chars");
  if (!Array.isArray(payouts)) errors.push("payouts must be an array");
  else {
    payouts.forEach((p, i) => {
      if (!isPlainObject(p)) return void errors.push(`payouts[${i}] must be an object`);
      for (const k of extraKeys(p, ["role", "amountStroops"])) errors.push(`payouts[${i}] unexpected field "${k}"`);
      if (typeof p.role !== "string" || !ROLES.includes(p.role as Role)) errors.push(`payouts[${i}].role must be SHIPOWNER|LP|TREASURY`);
      if (typeof p.amountStroops !== "string" || !/^[0-9]+$/.test(p.amountStroops)) errors.push(`payouts[${i}].amountStroops must be a decimal integer string`);
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, decision: input as unknown as AgentDecision };
}

export type InvoiceState = "REGISTERED" | "FUNDED" | "ADVANCED" | "IN_TRANSIT" | "DELIVERED" | "PAID" | "SETTLED" | "HOLD" | (string & {});

export interface ExecutorGates {
  /** Waybill hash newly registered by us. */
  hashRegisteredByUs: boolean;
  /** AIS says vessel is underway. */
  vesselUnderway: boolean;
  /** Velo payment.succeeded verified for this invoice. */
  webhookVerified: boolean;
  /** Amount in the verified webhook, stroops. If provided it must equal face value. */
  webhookAmount?: bigint;
  /** Berthing attestation present. */
  berthingAttestation: boolean;
  /** Injected fact: invoice due date + grace period has passed. Required for DEFAULT. */
  dueDatePlusGracePassed?: boolean;
}

export interface ExecutorSigners {
  AGENT: NoirSigner;
  SHIPOWNER: NoirSigner;
  LP: NoirSigner;
  TREASURY: NoirSigner;
}

export type ExecutorClient = Pick<NoirAgentClient, "checkPayment" | "authorizePayment" | "claim" | "balanceOf">;

/** Everything the executor needs, injected (no DB, webhook or LLM imports). */
export interface ExecutorContext {
  client: ExecutorClient;
  invoice: { id: string; state: InvoiceState; faceValue: bigint };
  deviceHash: string;
  /** Role -> stored address. The model never supplies addresses. */
  addresses: Record<Role, string>;
  signers: ExecutorSigners;
  gates: ExecutorGates;
  /**
   * Optional ops hook that runs defaultRecovery for this invoice. `execute` NEVER calls it:
   * only the explicit `runDefaultRecovery` does.
   */
  recovery?: () => Promise<DefaultRecoveryResult>;
}

export interface StepLog {
  step: "authorize" | "claim";
  role: Role;
  /** Payout amount in stroops (claim pays out all pending for the payee). */
  amount: bigint;
  hash: string;
  explorerUrl: string;
}

export interface ExecutionFailure {
  step: "precondition" | "check" | "authorize" | "claim" | "read";
  role?: Role;
  /** Stable machine reason, e.g. over_limit, insufficient_escrow, payout_mismatch. */
  reason: string;
  detail?: string;
}

export interface ExecutionResult {
  /** Final decision: the requested one if it fully executed, otherwise HOLD. */
  decision: DecisionKind;
  requested: DecisionKind;
  invoiceId: string;
  reason: string;
  /** True when the requested decision executed completely (HOLD/DEFAULT requested count as ok, nothing sent). */
  ok: boolean;
  /** Present when decision was forced to HOLD. */
  refusal?: string;
  failure?: ExecutionFailure;
  steps: StepLog[];
  /** Roles whose authorize landed on-chain. */
  authorized: Role[];
  /** Roles whose claim landed. */
  claimed: Role[];
  /** Authorized but not claimed (funds sit in the payee's pending balance). */
  pendingUnclaimed: Role[];
  /** Escrow balance after execution; null if it could not be read. */
  finalEscrowBalance: bigint | null;
}

const SETTLE_ORDER: readonly Role[] = ["LP", "SHIPOWNER", "TREASURY"];

function expectedPayouts(kind: "ADVANCE" | "SETTLE", faceValue: bigint): { role: Role; amount: bigint }[] {
  const p = computePayouts(faceValue);
  if (kind === "ADVANCE") return [{ role: "SHIPOWNER", amount: p.advance }];
  return [
    { role: "LP", amount: p.lpRepayment },
    { role: "SHIPOWNER", amount: p.rebate },
    { role: "TREASURY", amount: p.fee },
  ];
}

function gateFailure(kind: "ADVANCE" | "SETTLE", ctx: ExecutorContext): string | null {
  const { gates, invoice } = ctx;
  if (kind === "ADVANCE") {
    if (invoice.state !== "FUNDED") return "state_not_funded";
    if (!gates.hashRegisteredByUs) return "hash_not_registered";
    if (!gates.vesselUnderway) return "vessel_not_underway";
    return null;
  }
  if (invoice.state !== "PAID") return "state_not_paid";
  if (!gates.webhookVerified) return "webhook_not_verified";
  if (gates.webhookAmount !== undefined && gates.webhookAmount !== invoice.faceValue) return "webhook_amount_mismatch";
  if (!gates.berthingAttestation) return "attestation_missing";
  return null;
}

function holdResult(
  d: { invoiceId: string; decision: DecisionKind },
  failure: ExecutionFailure,
  extra: Partial<ExecutionResult> = {},
): ExecutionResult {
  return {
    decision: "HOLD",
    requested: d.decision,
    invoiceId: d.invoiceId,
    reason: failure.reason,
    ok: false,
    refusal: failure.reason,
    failure,
    steps: [],
    authorized: [],
    claimed: [],
    pendingUnclaimed: [],
    finalEscrowBalance: null,
    ...extra,
  };
}

/**
 * Convert an AgentDecision into Noir calls. Never throws; returns what landed.
 * `input` is `unknown` on purpose: it is validated here, so raw model output can be passed straight in.
 */
export async function execute(input: unknown, ctx: ExecutorContext): Promise<ExecutionResult> {
  const v = validateDecision(input);
  if (!v.ok) {
    const id = isPlainObject(input) && typeof input.invoiceId === "string" ? input.invoiceId : ctx.invoice.id;
    return holdResult({ invoiceId: id, decision: "HOLD" }, { step: "precondition", reason: "invalid_decision", detail: v.errors.join("; ") });
  }
  const d = v.decision;

  // DEFAULT: never sends payouts. Needs due date + grace passed and no verified payment, else HOLD.
  if (d.decision === "DEFAULT") {
    const failure = defaultPrecondition(d.invoiceId, ctx);
    if (failure) return holdResult(d, failure, { finalEscrowBalance: await readBalance(ctx) });
  }

  // HOLD / DEFAULT: nothing is ever sent.
  if (d.decision === "HOLD" || d.decision === "DEFAULT") {
    return {
      decision: d.decision,
      requested: d.decision,
      invoiceId: d.invoiceId,
      reason: d.reason,
      ok: true,
      steps: [],
      authorized: [],
      claimed: [],
      pendingUnclaimed: [],
      finalEscrowBalance: await readBalance(ctx),
    };
  }

  const kind = d.decision;
  const fail = (f: ExecutionFailure, extra: Partial<ExecutionResult> = {}) => holdResult(d, f, extra);

  if (d.invoiceId !== ctx.invoice.id) return fail({ step: "precondition", reason: "invoice_mismatch", detail: `${d.invoiceId} != ${ctx.invoice.id}` });
  if (ctx.invoice.faceValue <= 0n) return fail({ step: "precondition", reason: "invalid_face_value" });

  // Roles map only to ctx addresses; signers must match them.
  for (const role of ROLES) {
    const addr = ctx.addresses[role];
    if (typeof addr !== "string" || !addr) return fail({ step: "precondition", reason: "missing_address", role });
    if (ctx.signers[role].publicKey !== addr) return fail({ step: "precondition", reason: "signer_address_mismatch", role });
  }

  const gate = gateFailure(kind, ctx);
  if (gate) return fail({ step: "precondition", reason: gate });

  // Model explains, code computes: payouts must equal the recomputed amounts.
  const expected = expectedPayouts(kind, ctx.invoice.faceValue);
  const proposed = d.payouts.map((p) => ({ role: p.role, amount: BigInt(p.amountStroops) }));
  if (kind === "SETTLE") {
    const sum = proposed.reduce((a, p) => a + p.amount, 0n);
    if (sum !== ctx.invoice.faceValue) return fail({ step: "precondition", reason: "payout_mismatch", detail: `sum ${sum} != V ${ctx.invoice.faceValue}` });
  }
  const norm = (xs: { role: Role; amount: bigint }[]) => xs.map((x) => `${x.role}:${x.amount}`).sort().join(",");
  if (norm(proposed) !== norm(expected)) {
    return fail({ step: "precondition", reason: "payout_mismatch", detail: `expected ${norm(expected)} got ${norm(proposed)}` });
  }
  if (kind === "SETTLE" && settlementTotal(computePayouts(ctx.invoice.faceValue)) !== ctx.invoice.faceValue) {
    return fail({ step: "precondition", reason: "payout_mismatch", detail: "internal conservation check failed" });
  }

  // Escrow must cover everything before the first send, so SETTLE cannot half-land for lack of funds.
  const total = expected.reduce((a, p) => a + p.amount, 0n);
  let escrow: bigint;
  try {
    escrow = await ctx.client.balanceOf(ctx.deviceHash);
  } catch (e) {
    return fail({ step: "read", reason: "chain_error", detail: normalizeError(e).message });
  }
  if (escrow < total) return fail({ step: "precondition", reason: "insufficient_escrow", detail: `escrow ${escrow} < required ${total}` }, { finalEscrowBalance: escrow });

  // Mandatory checkPayment for every payout BEFORE the first authorize (all-or-nothing preflight).
  const agent = ctx.signers.AGENT.publicKey;
  const ordered = kind === "SETTLE" ? SETTLE_ORDER.map((r) => expected.find((x) => x.role === r)!) : expected;
  for (const p of ordered) {
    try {
      const chk = await ctx.client.checkPayment({ deviceHash: ctx.deviceHash, agent, amount: p.amount, requireEscrow: true });
      if (!chk.ok) return fail({ step: "check", role: p.role, reason: chk.reason }, { finalEscrowBalance: escrow });
    } catch (e) {
      return fail({ step: "check", role: p.role, reason: "chain_error", detail: normalizeError(e).message }, { finalEscrowBalance: escrow });
    }
  }

  // Send. Sequential authorizes first, then each payee claims.
  const steps: StepLog[] = [];
  const authorized: Role[] = [];
  const claimed: Role[] = [];
  const report = async (f: ExecutionFailure): Promise<ExecutionResult> =>
    holdResult(d, f, {
      steps,
      authorized,
      claimed,
      pendingUnclaimed: authorized.filter((r) => !claimed.includes(r)),
      finalEscrowBalance: await readBalance(ctx),
    });

  for (const p of ordered) {
    try {
      const r = await ctx.client.authorizePayment({
        agentSigner: ctx.signers.AGENT,
        deviceHash: ctx.deviceHash,
        merchant: ctx.addresses[p.role],
        amount: p.amount,
      });
      if (!r.ok) return report({ step: "authorize", role: p.role, reason: r.reason });
      steps.push({ step: "authorize", role: p.role, amount: p.amount, hash: r.hash, explorerUrl: r.explorerUrl });
      authorized.push(p.role);
    } catch (e) {
      const ce = normalizeError(e);
      return report({ step: "authorize", role: p.role, reason: "chain_error", detail: `${ce.errorName}: ${ce.message}` });
    }
  }

  let claimFailure: ExecutionFailure | null = null;
  for (const p of ordered) {
    try {
      const r = await ctx.client.claim(ctx.signers[p.role]);
      steps.push({ step: "claim", role: p.role, amount: p.amount, hash: r.hash, explorerUrl: r.explorerUrl });
      claimed.push(p.role);
    } catch (e) {
      const ce = normalizeError(e);
      claimFailure ??= { step: "claim", role: p.role, reason: "chain_error", detail: `${ce.errorName}: ${ce.message}` };
      // keep going: other payees' claims are independent
    }
  }
  if (claimFailure) return report(claimFailure);

  const finalEscrowBalance = await readBalance(ctx);
  return {
    decision: kind,
    requested: kind,
    invoiceId: d.invoiceId,
    reason: d.reason,
    ok: true,
    steps,
    authorized,
    claimed,
    pendingUnclaimed: [],
    finalEscrowBalance,
  };
}

async function readBalance(ctx: ExecutorContext): Promise<bigint | null> {
  try {
    return await ctx.client.balanceOf(ctx.deviceHash);
  } catch {
    return null;
  }
}

function defaultPrecondition(invoiceId: string, ctx: ExecutorContext): ExecutionFailure | null {
  const f = (reason: string): ExecutionFailure => ({ step: "precondition", reason });
  if (invoiceId !== ctx.invoice.id) return f("invoice_mismatch");
  if (ctx.gates.dueDatePlusGracePassed !== true) return f("default_not_due");
  if (ctx.gates.webhookVerified) return f("payment_verified");
  if (ctx.invoice.state === "PAID" || ctx.invoice.state === "SETTLED") return f("payment_verified");
  return null;
}

/**
 * Explicit ops trigger for the recovery sequence (revoke agent + sweep escrow to Treasury).
 * Only runs for an executed DEFAULT result and when ctx.recovery is provided; never automatic.
 */
export async function runDefaultRecovery(result: ExecutionResult, ctx: ExecutorContext): Promise<DefaultRecoveryResult> {
  if (result.decision !== "DEFAULT" || !result.ok) throw new Error(`recovery requires an executed DEFAULT decision (got ${result.decision}, ok=${result.ok})`);
  if (!ctx.recovery) throw new Error("no recovery hook configured in ExecutorContext");
  return ctx.recovery();
}
