import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { toStroops } from "@noirxvelo/shared";
import {
  NoirAgentClient, keypairSigner, defaultRecovery, execute, runDefaultRecovery, explorerTxUrl, RecoveryError,
  type ExecutorContext, type NoirSigner, type AgentDecision, type DefaultRecoveryResult,
} from "../src/index.js";

const signer = (pk: string): NoirSigner => ({ publicKey: pk, signTransaction: async (x) => x });
const E = toStroops("850");

function mkClient(over: Record<string, any> = {}) {
  let escrow = E;
  const client = {
    balanceOf: vi.fn(async () => escrow),
    unlinkDevice: vi.fn(async () => {
      const r = escrow;
      escrow = 0n;
      return { hashes: ["h1", "h2"], txs: ["h1", "h2"].map((h) => ({ hash: h, explorerUrl: explorerTxUrl(h) })), escrowReturned: r };
    }),
    checkPayment: vi.fn(async () => ({ ok: false, reason: "no_agent" })),
    authorizePayment: vi.fn(async () => ({ ok: false, refused: true, reason: "no_agent" })),
    ...over,
  };
  return client;
}

function mkBalances() {
  let n = 0;
  return vi.fn(async () => (n++ === 0 ? toStroops("1000") : toStroops("1849.99")));
}

describe("defaultRecovery", () => {
  it("returns hashes, links, escrow returned and treasury delta", async () => {
    const client = mkClient();
    const r = await defaultRecovery({ client: client as any, ownerSigner: signer("G_T"), deviceHash: "dd", agent: signer("G_A"), readTreasuryBalance: mkBalances() });
    expect(r).toMatchObject({ hashes: ["h1", "h2"], escrowBefore: E, escrowReturned: E, escrowAfter: 0n, checkAfterRevoke: "no_agent", authorizeRefused: "no_agent" });
    expect(r.txs[0].explorerUrl).toBe(explorerTxUrl("h1"));
    expect(r.treasuryAfter - r.treasuryBefore).toBe(toStroops("849.99"));
    expect(client.unlinkDevice).toHaveBeenCalledWith(expect.objectContaining({ publicKey: "G_T" }), "dd");
  });
  it("throws when escrow not empty after sweep", async () => {
    const client = mkClient({ unlinkDevice: vi.fn(async () => ({ hashes: ["h"], txs: [], escrowReturned: 0n })) });
    await expect(defaultRecovery({ client: client as any, ownerSigner: signer("G_T"), deviceHash: "dd", agent: signer("G_A"), readTreasuryBalance: mkBalances() })).rejects.toBeInstanceOf(RecoveryError);
  });
  it("throws if revoked agent can still pay", async () => {
    const client = mkClient({ checkPayment: vi.fn(async () => ({ ok: true })) });
    await expect(defaultRecovery({ client: client as any, ownerSigner: signer("G_T"), deviceHash: "dd", agent: signer("G_A"), readTreasuryBalance: mkBalances() })).rejects.toThrow(/still ok/);
  });
});

describe("executor DEFAULT", () => {
  const dec: AgentDecision = { invoiceId: "INV-2026-001", decision: "DEFAULT", reason: "unpaid", payouts: [] };
  const mk = (gates: Partial<ExecutorContext["gates"]> = {}, state = "ADVANCED", recovery?: () => Promise<DefaultRecoveryResult>) => {
    const client = { balanceOf: vi.fn(async () => E), checkPayment: vi.fn(), authorizePayment: vi.fn(), claim: vi.fn() };
    const ctx: ExecutorContext = {
      client: client as any,
      invoice: { id: "INV-2026-001", state, faceValue: toStroops("1000") },
      deviceHash: "dd",
      addresses: { SHIPOWNER: "a", LP: "b", TREASURY: "c" },
      signers: { AGENT: signer("x"), SHIPOWNER: signer("a"), LP: signer("b"), TREASURY: signer("c") },
      gates: { hashRegisteredByUs: true, vesselUnderway: true, webhookVerified: false, berthingAttestation: false, dueDatePlusGracePassed: true, ...gates },
      recovery,
    };
    return { ctx, client };
  };
  it("ok when due+grace passed and unpaid; sends nothing; does not auto-run recovery", async () => {
    const rec = vi.fn();
    const { ctx, client } = mk({}, "ADVANCED", rec as any);
    const r = await execute(dec, ctx);
    expect(r).toMatchObject({ decision: "DEFAULT", ok: true, steps: [] });
    expect(rec).not.toHaveBeenCalled();
    expect(client.authorizePayment).not.toHaveBeenCalled();
  });
  it("HOLD default_not_due when grace not passed or fact missing", async () => {
    for (const g of [{ dueDatePlusGracePassed: false }, { dueDatePlusGracePassed: undefined }]) {
      expect(await execute(dec, mk(g).ctx)).toMatchObject({ decision: "HOLD", requested: "DEFAULT", reason: "default_not_due" });
    }
  });
  it("HOLD payment_verified when webhook verified or invoice paid", async () => {
    expect(await execute(dec, mk({ webhookVerified: true }).ctx)).toMatchObject({ decision: "HOLD", reason: "payment_verified" });
    expect(await execute(dec, mk({}, "PAID").ctx)).toMatchObject({ decision: "HOLD", reason: "payment_verified" });
  });
  it("runDefaultRecovery runs hook only for executed DEFAULT", async () => {
    const out = { escrowReturned: E } as DefaultRecoveryResult;
    const rec = vi.fn(async () => out);
    const { ctx } = mk({}, "ADVANCED", rec);
    const r = await execute(dec, ctx);
    expect(await runDefaultRecovery(r, ctx)).toBe(out);
    expect(rec).toHaveBeenCalledOnce();
    const held = await execute(dec, mk({ dueDatePlusGracePassed: false }, "ADVANCED", rec).ctx);
    await expect(runDefaultRecovery(held, ctx)).rejects.toThrow(/executed DEFAULT/);
    await expect(runDefaultRecovery(r, { ...ctx, recovery: undefined })).rejects.toThrow(/no recovery hook/);
  });
});

describe.skipIf(process.env.LIVE !== "1")("live default recovery", () => {
  it("register + agent + fund 850 -> defaultRecovery -> Treasury +850 minus fees", { timeout: 600_000 }, async () => {
    process.loadEnvFile(resolve(__dirname, "../../../.env.local"));
    const env = (k: string) => process.env[k]!;
    const treasury = keypairSigner(env("TREASURY_SECRET"));
    const lp = keypairSigner(env("LP_SECRET"));
    const agent = keypairSigner(env("AGENT_SECRET"));
    const c = new NoirAgentClient();
    const deviceHash = randomBytes(32).toString("hex");
    await c.registerDevice(treasury, deviceHash, env("AGENT_PUBLIC"));
    await c.registerAgent(treasury, deviceHash, env("AGENT_PUBLIC"), toStroops("880"));
    await c.fundEscrow(lp, deviceHash, E);
    const r = await defaultRecovery({ client: c, ownerSigner: treasury, deviceHash, agent });
    const delta = r.treasuryAfter - r.treasuryBefore;
    console.log("LIVE RECOVERY", JSON.stringify({ deviceHash, links: r.txs.map((t) => t.explorerUrl), escrowReturned: r.escrowReturned, delta, check: r.checkAfterRevoke, auth: r.authorizeRefused }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
    expect(r.escrowAfter).toBe(0n);
    expect(r.escrowReturned).toBe(E);
    expect(delta).toBeGreaterThan(E - toStroops("1"));
    expect(delta).toBeLessThanOrEqual(E);
    expect(r.checkAfterRevoke).toBe("no_agent");
  });
});
