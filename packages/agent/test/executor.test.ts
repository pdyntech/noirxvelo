import { describe, it, expect, vi } from "vitest";
import { computePayouts, toStroops } from "@noirxvelo/shared";
import { execute, validateDecision, ChainError, explorerTxUrl, type ExecutorContext, type AgentDecision, type NoirSigner } from "../src/index.js";

const signer = (pk: string): NoirSigner => ({ publicKey: pk, signTransaction: async (x) => x });
const V = toStroops("1000");
const P = computePayouts(V);
const ADDR = { SHIPOWNER: "G_SHIP", LP: "G_LP", TREASURY: "G_TREAS" };

function mkClient(over: Record<string, any> = {}) {
  const log: string[] = [];
  const client = {
    balanceOf: vi.fn(async () => V),
    checkPayment: vi.fn(async () => ({ ok: true })),
    authorizePayment: vi.fn(async (p: any) => {
      log.push(`auth:${p.merchant}:${p.amount}`);
      return { ok: true, nonce: 1n, hash: `a-${p.merchant}`, explorerUrl: explorerTxUrl(`a-${p.merchant}`) };
    }),
    claim: vi.fn(async (s: NoirSigner) => {
      log.push(`claim:${s.publicKey}`);
      return { hash: `c-${s.publicKey}`, explorerUrl: explorerTxUrl(`c-${s.publicKey}`) };
    }),
    ...over,
  };
  return { client, log };
}

function mkCtx(over: Partial<ExecutorContext> = {}, clientOver: Record<string, any> = {}) {
  const { client, log } = mkClient(clientOver);
  const ctx: ExecutorContext = {
    client: client as any,
    invoice: { id: "INV-2026-001", state: "FUNDED", faceValue: V },
    deviceHash: "ab".repeat(32),
    addresses: ADDR,
    signers: { AGENT: signer("G_AGENT"), SHIPOWNER: signer("G_SHIP"), LP: signer("G_LP"), TREASURY: signer("G_TREAS") },
    gates: { hashRegisteredByUs: true, vesselUnderway: true, webhookVerified: true, berthingAttestation: true },
    ...over,
  };
  return { ctx, client, log };
}

const advance = (): AgentDecision => ({ invoiceId: "INV-2026-001", decision: "ADVANCE", reason: "go", payouts: [{ role: "SHIPOWNER", amountStroops: P.advance.toString() }] });
const settle = (): AgentDecision => ({
  invoiceId: "INV-2026-001",
  decision: "SETTLE",
  reason: "paid",
  payouts: [
    { role: "TREASURY", amountStroops: P.fee.toString() },
    { role: "SHIPOWNER", amountStroops: P.rebate.toString() },
    { role: "LP", amountStroops: P.lpRepayment.toString() },
  ],
});
const paid = { invoice: { id: "INV-2026-001", state: "PAID", faceValue: V } };

describe("validateDecision", () => {
  it("accepts a valid decision", () => expect(validateDecision(advance()).ok).toBe(true));
  it.each([
    ["extra top-level field", { ...advance(), foo: 1 }],
    ["extra payout field", { ...advance(), payouts: [{ role: "LP", amountStroops: "1", to: "G" }] }],
    ["bad role", { ...advance(), payouts: [{ role: "HACKER", amountStroops: "1" }] }],
    ["non-integer amount", { ...advance(), payouts: [{ role: "LP", amountStroops: "1.5" }] }],
    ["numeric amount", { ...advance(), payouts: [{ role: "LP", amountStroops: 5 }] }],
    ["negative amount", { ...advance(), payouts: [{ role: "LP", amountStroops: "-5" }] }],
    ["bad invoice id", { ...advance(), invoiceId: "INV-26-1" }],
    ["bad decision", { ...advance(), decision: "PAYALL" }],
    ["long reason", { ...advance(), reason: "x".repeat(281) }],
    ["not an object", "ADVANCE"],
  ])("rejects %s", (_n, d) => expect(validateDecision(d).ok).toBe(false));
});

describe("execute: preconditions", () => {
  it("invalid decision -> HOLD, nothing sent", async () => {
    const { ctx, client } = mkCtx();
    const r = await execute({ ...advance(), extra: 1 }, ctx);
    expect(r).toMatchObject({ decision: "HOLD", reason: "invalid_decision", ok: false });
    expect(client.authorizePayment).not.toHaveBeenCalled();
  });
  it.each([
    ["state not FUNDED", { invoice: { id: "INV-2026-001", state: "PAID", faceValue: V } }, "state_not_funded"],
    ["hash not registered", { gates: { hashRegisteredByUs: false, vesselUnderway: true, webhookVerified: true, berthingAttestation: true } }, "hash_not_registered"],
    ["vessel not underway", { gates: { hashRegisteredByUs: true, vesselUnderway: false, webhookVerified: true, berthingAttestation: true } }, "vessel_not_underway"],
  ])("ADVANCE %s -> HOLD", async (_n, over, reason) => {
    const { ctx, client } = mkCtx(over as any);
    const r = await execute(advance(), ctx);
    expect(r).toMatchObject({ decision: "HOLD", requested: "ADVANCE", refusal: reason });
    expect(client.authorizePayment).not.toHaveBeenCalled();
  });
  it("ADVANCE escrow below advance -> HOLD insufficient_escrow", async () => {
    const { ctx, client } = mkCtx({}, { balanceOf: vi.fn(async () => P.advance - 1n) });
    const r = await execute(advance(), ctx);
    expect(r.refusal).toBe("insufficient_escrow");
    expect(client.authorizePayment).not.toHaveBeenCalled();
  });
  it.each([
    ["state not PAID", { invoice: { id: "INV-2026-001", state: "FUNDED", faceValue: V } }, "state_not_paid"],
    ["webhook unverified", { ...paid, gates: { hashRegisteredByUs: true, vesselUnderway: true, webhookVerified: false, berthingAttestation: true } }, "webhook_not_verified"],
    ["webhook amount != V", { ...paid, gates: { hashRegisteredByUs: true, vesselUnderway: true, webhookVerified: true, webhookAmount: V - 1n, berthingAttestation: true } }, "webhook_amount_mismatch"],
    ["no attestation", { ...paid, gates: { hashRegisteredByUs: true, vesselUnderway: true, webhookVerified: true, berthingAttestation: false } }, "attestation_missing"],
  ])("SETTLE %s -> HOLD", async (_n, over, reason) => {
    const { ctx, client } = mkCtx(over as any);
    const r = await execute(settle(), ctx);
    expect(r).toMatchObject({ decision: "HOLD", requested: "SETTLE", refusal: reason });
    expect(client.authorizePayment).not.toHaveBeenCalled();
  });
  it("invoice id mismatch -> HOLD", async () => {
    const { ctx } = mkCtx({ invoice: { id: "INV-2026-002", state: "FUNDED", faceValue: V } });
    expect((await execute(advance(), ctx)).refusal).toBe("invoice_mismatch");
  });
  it("signer/address mismatch -> HOLD (role->address map is authoritative)", async () => {
    const { ctx } = mkCtx({ addresses: { ...ADDR, LP: "G_OTHER" } });
    expect(await execute(advance(), ctx)).toMatchObject({ refusal: "signer_address_mismatch", failure: { role: "LP" } });
  });
});

describe("execute: payout mismatch", () => {
  it("ADVANCE with wrong amount -> payout_mismatch", async () => {
    const { ctx, client } = mkCtx();
    const d = advance();
    d.payouts[0]!.amountStroops = (P.advance + 1n).toString();
    expect(await execute(d, ctx)).toMatchObject({ decision: "HOLD", reason: "payout_mismatch" });
    expect(client.authorizePayment).not.toHaveBeenCalled();
  });
  it("ADVANCE with wrong role -> payout_mismatch", async () => {
    const { ctx } = mkCtx();
    const d = advance();
    d.payouts[0]!.role = "LP";
    expect((await execute(d, ctx)).reason).toBe("payout_mismatch");
  });
  it("SETTLE sum != V -> payout_mismatch", async () => {
    const { ctx, client } = mkCtx(paid);
    const d = settle();
    d.payouts[0]!.amountStroops = "0";
    const r = await execute(d, ctx);
    expect(r.reason).toBe("payout_mismatch");
    expect(r.failure?.detail).toMatch(/sum/);
    expect(client.authorizePayment).not.toHaveBeenCalled();
  });
  it("SETTLE sum == V but split wrong -> payout_mismatch", async () => {
    const { ctx } = mkCtx(paid);
    const d = settle();
    d.payouts.find((p) => p.role === "LP")!.amountStroops = (P.lpRepayment - 10n).toString();
    d.payouts.find((p) => p.role === "SHIPOWNER")!.amountStroops = (P.rebate + 10n).toString();
    expect((await execute(d, ctx)).reason).toBe("payout_mismatch");
  });
  it("SETTLE with missing payee -> payout_mismatch", async () => {
    const { ctx } = mkCtx(paid);
    const d = settle();
    d.payouts.pop();
    expect((await execute(d, ctx)).reason).toBe("payout_mismatch");
  });
});

describe("execute: happy paths", () => {
  it("ADVANCE: authorize shipowner then claim", async () => {
    const { ctx, client, log } = mkCtx({}, { balanceOf: vi.fn().mockResolvedValueOnce(P.advance).mockResolvedValue(0n) });
    const r = await execute(advance(), ctx);
    expect(r).toMatchObject({ decision: "ADVANCE", ok: true, finalEscrowBalance: 0n, authorized: ["SHIPOWNER"], claimed: ["SHIPOWNER"] });
    expect(log).toEqual([`auth:G_SHIP:${P.advance}`, "claim:G_SHIP"]);
    expect(r.steps.map((s) => s.step)).toEqual(["authorize", "claim"]);
    expect(r.steps[0]).toMatchObject({ hash: "a-G_SHIP", explorerUrl: explorerTxUrl("a-G_SHIP"), amount: P.advance });
    expect(client.checkPayment).toHaveBeenCalledWith(expect.objectContaining({ agent: "G_AGENT", amount: P.advance, requireEscrow: true }));
  });
  it("SETTLE: 3 authorizes in order LP, SHIPOWNER, TREASURY (sum == V), then claims; escrow 0", async () => {
    const { ctx, log } = mkCtx(paid, { balanceOf: vi.fn().mockResolvedValueOnce(V).mockResolvedValue(0n) });
    const r = await execute(settle(), ctx); // model listed TREASURY first; order is fixed by code
    expect(r).toMatchObject({ decision: "SETTLE", ok: true, finalEscrowBalance: 0n });
    expect(log).toEqual([
      `auth:G_LP:${P.lpRepayment}`,
      `auth:G_SHIP:${P.rebate}`,
      `auth:G_TREAS:${P.fee}`,
      "claim:G_LP",
      "claim:G_SHIP",
      "claim:G_TREAS",
    ]);
    const sum = r.steps.filter((s) => s.step === "authorize").reduce((a, s) => a + s.amount, 0n);
    expect(sum).toBe(V);
    expect(r.steps).toHaveLength(6);
  });
  it("addresses come only from ctx", async () => {
    const { ctx, client } = mkCtx(paid);
    await execute(settle(), ctx);
    const merchants = (client.authorizePayment as any).mock.calls.map((c: any[]) => c[0].merchant);
    expect(merchants).toEqual(["G_LP", "G_SHIP", "G_TREAS"]);
  });
  it("HOLD and DEFAULT send nothing", async () => {
    for (const decision of ["HOLD", "DEFAULT"] as const) {
      const { ctx, client } = mkCtx({
        gates: { hashRegisteredByUs: true, vesselUnderway: true, webhookVerified: false, berthingAttestation: false, dueDatePlusGracePassed: true },
      });
      const r = await execute({ invoiceId: "INV-2026-001", decision, reason: "x", payouts: [] }, ctx);
      expect(r).toMatchObject({ decision, ok: true, steps: [] });
      expect(client.authorizePayment).not.toHaveBeenCalled();
      expect(client.claim).not.toHaveBeenCalled();
    }
  });
});

describe("execute: refusals and partial failure", () => {
  it("checkPayment over_limit in preflight -> HOLD before any send", async () => {
    const { ctx, client } = mkCtx(paid, { checkPayment: vi.fn(async () => ({ ok: false, reason: "over_limit" })) });
    const r = await execute(settle(), ctx);
    expect(r).toMatchObject({ decision: "HOLD", reason: "over_limit", failure: { step: "check", role: "LP" } });
    expect(client.authorizePayment).not.toHaveBeenCalled();
  });
  it("checkPayment insufficient_escrow -> HOLD", async () => {
    const { ctx } = mkCtx({}, { checkPayment: vi.fn(async () => ({ ok: false, reason: "insufficient_escrow" })) });
    expect(await execute(advance(), ctx)).toMatchObject({ decision: "HOLD", reason: "insufficient_escrow" });
  });
  it("wrapper expired refusal on 2nd authorize -> HOLD reporting LP landed", async () => {
    let n = 0;
    const { ctx, log } = mkCtx(paid, {
      authorizePayment: vi.fn(async (p: any) => {
        if (++n === 2) return { ok: false, refused: true, reason: "expired" };
        log.push(`auth:${p.merchant}`);
        return { ok: true, nonce: 1n, hash: "h1", explorerUrl: explorerTxUrl("h1") };
      }),
    });
    const r = await execute(settle(), ctx);
    expect(r).toMatchObject({ decision: "HOLD", requested: "SETTLE", reason: "expired", failure: { step: "authorize", role: "SHIPOWNER" } });
    expect(r.authorized).toEqual(["LP"]);
    expect(r.pendingUnclaimed).toEqual(["LP"]);
    expect(r.steps).toHaveLength(1);
    expect(log).toEqual(["auth:G_LP"]);
  });
  it("thrown ChainError on authorize is caught and reported", async () => {
    let n = 0;
    const { ctx } = mkCtx(paid, {
      authorizePayment: vi.fn(async (p: any) => {
        if (++n === 3) throw new ChainError("boom", { errorName: "InsufficientBalance" });
        return { ok: true, nonce: 1n, hash: `h${n}`, explorerUrl: explorerTxUrl(`h${n}`) };
      }),
    });
    const r = await execute(settle(), ctx);
    expect(r.decision).toBe("HOLD");
    expect(r.failure).toMatchObject({ step: "authorize", role: "TREASURY", reason: "chain_error" });
    expect(r.failure?.detail).toContain("InsufficientBalance");
    expect(r.authorized).toEqual(["LP", "SHIPOWNER"]);
    expect(r.claimed).toEqual([]);
  });
  it("claim NothingToClaim (an earlier claim already paid the payee out) counts as claimed", async () => {
    const { ctx } = mkCtx(paid, {
      claim: vi.fn(async (s: NoirSigner) => {
        if (s.publicKey === "G_TREAS") throw new ChainError("nothing pending", { errorName: "NothingToClaim" });
        return { hash: `c-${s.publicKey}`, explorerUrl: "u" };
      }),
    });
    const r = await execute(settle(), ctx);
    expect(r).toMatchObject({ decision: "SETTLE", ok: true, pendingUnclaimed: [] });
    expect(r.claimed).toEqual(["LP", "SHIPOWNER", "TREASURY"]);
    expect(r.steps.filter((x) => x.step === "claim").map((x) => x.role)).toEqual(["LP", "SHIPOWNER"]);
  });

  it("claim failure: other claims still attempted, reported", async () => {
    const { ctx, client } = mkCtx(paid, {
      claim: vi.fn(async (s: NoirSigner) => {
        if (s.publicKey === "G_SHIP") throw new Error("claim boom");
        return { hash: `c-${s.publicKey}`, explorerUrl: "u" };
      }),
    });
    const r = await execute(settle(), ctx);
    expect(r).toMatchObject({ decision: "HOLD", ok: false, failure: { step: "claim", role: "SHIPOWNER" } });
    expect(client.claim).toHaveBeenCalledTimes(3);
    expect(r.authorized).toEqual(["LP", "SHIPOWNER", "TREASURY"]);
    expect(r.claimed).toEqual(["LP", "TREASURY"]);
    expect(r.pendingUnclaimed).toEqual(["SHIPOWNER"]);
  });
  it("balance read failure never throws", async () => {
    const { ctx } = mkCtx({}, { balanceOf: vi.fn(async () => { throw new Error("rpc down"); }) });
    const r = await execute(advance(), ctx);
    expect(r).toMatchObject({ decision: "HOLD", failure: { step: "read" } });
  });
});
