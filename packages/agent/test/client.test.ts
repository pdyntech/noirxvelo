import { describe, it, expect, vi } from "vitest";
import { NoirContractError } from "@noirx402/agent-sdk";
import { NoirAgentClient, XLM_SAC, ChainError, InvoiceAlreadyFinancedError, KeyedMutex, explorerTxUrl, type SdkLike, type NoirSigner } from "../src/index.js";

const signer = (pk: string): NoirSigner => ({ publicKey: pk, signTransaction: async (x) => x });
const HASH = "ab".repeat(32);

function mockSdk(over: Partial<Record<keyof SdkLike, any>> = {}) {
  return {
    execute: vi.fn(async () => ({ hash: "h-exec" })),
    checkPayment: vi.fn(async () => ({ ok: true })),
    authorizePayment: vi.fn(async () => ({ hash: "h-auth", nonce: 7n })),
    claim: vi.fn(async () => ({ hash: "h-claim" })),
    unlinkDevice: vi.fn(async () => ({ hashes: ["u1", "u2"], escrowReturned: 5n })),
    getEscrowBalance: vi.fn(async () => 42n),
    getPendingBalance: vi.fn(async () => 9n),
    ...over,
  } as unknown as SdkLike & Record<string, ReturnType<typeof vi.fn>>;
}

describe("link building", () => {
  it("builds stellar.expert testnet url", () => {
    expect(explorerTxUrl("abc")).toBe("https://stellar.expert/explorer/testnet/tx/abc");
  });
  it("writes return hash + explorerUrl and use XLM SAC", async () => {
    const sdk = mockSdk();
    const c = new NoirAgentClient({ sdk });
    const r = await c.fundEscrow(signer("G1"), HASH, 10n);
    expect(r).toEqual({ hash: "h-exec", explorerUrl: explorerTxUrl("h-exec") });
    expect(sdk.execute).toHaveBeenCalledWith(expect.anything(), { kind: "fundEscrow", deviceHash: HASH, token: XLM_SAC, amount: 10n });
    const reg = await c.registerAgent(signer("G1"), HASH, "GA", 5n);
    expect(reg.explorerUrl).toContain("h-exec");
    expect(sdk.execute).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: "registerAgent", asset: XLM_SAC, maxAmount: 5n }));
  });
});

describe("error normalisation", () => {
  it("keeps NoirContractError fields", async () => {
    const err = new NoirContractError("paymentEscrow", 3, "AgentNotAuthorized", "authorize");
    const sdk = mockSdk({ claim: vi.fn(async () => { throw err; }) });
    const e = await new NoirAgentClient({ sdk }).claim(signer("GM")).catch((x) => x);
    expect(e).toBeInstanceOf(ChainError);
    expect(e).toMatchObject({ errorName: "AgentNotAuthorized", code: 3, contract: "paymentEscrow", method: "authorize" });
  });
  it("maps AlreadyRegistered to invoice already financed", async () => {
    const err = new NoirContractError("deviceRegistry", 4, "AlreadyRegistered", "register");
    const sdk = mockSdk({ execute: vi.fn(async () => { throw err; }) });
    const e = await new NoirAgentClient({ sdk }).registerDevice(signer("G"), HASH, "GA").catch((x) => x);
    expect(e).toBeInstanceOf(InvoiceAlreadyFinancedError);
    expect(e.message).toBe("invoice already financed");
    expect(e).toMatchObject({ errorName: "AlreadyRegistered", code: 4, contract: "deviceRegistry", method: "register" });
  });
  it("wraps unknown errors", async () => {
    const sdk = mockSdk({ getEscrowBalance: vi.fn(async () => { throw new Error("boom"); }) });
    const e = await new NoirAgentClient({ sdk }).balanceOf(HASH).catch((x) => x);
    expect(e).toBeInstanceOf(ChainError);
    expect(e.message).toBe("boom");
  });
});

describe("authorizePayment", () => {
  for (const reason of ["over_limit", "expired", "insufficient_escrow", "wrong_agent"] as const) {
    it(`refuses ${reason} without sending`, async () => {
      const sdk = mockSdk({ checkPayment: vi.fn(async () => ({ ok: false, reason })) });
      const r = await new NoirAgentClient({ sdk }).authorizePayment({ agentSigner: signer("GA"), deviceHash: HASH, merchant: "GM", amount: 1n });
      expect(r).toEqual({ ok: false, refused: true, reason });
      expect(sdk.authorizePayment).not.toHaveBeenCalled();
      expect(sdk.checkPayment).toHaveBeenCalledWith(expect.objectContaining({ requireEscrow: true, agent: "GA", asset: XLM_SAC }));
    });
  }
  it("returns hash, explorerUrl and nonce on success", async () => {
    const r = await new NoirAgentClient({ sdk: mockSdk() }).authorizePayment({ agentSigner: signer("GA"), deviceHash: HASH, merchant: "GM", amount: 1n });
    expect(r).toEqual({ ok: true, hash: "h-auth", explorerUrl: explorerTxUrl("h-auth"), nonce: 7n });
  });
  it("serialises calls per (device, agent)", async () => {
    const log: string[] = [];
    let n = 0;
    const sdk = mockSdk({
      authorizePayment: vi.fn(async () => {
        const id = ++n;
        log.push(`start${id}`);
        await new Promise((r) => setTimeout(r, 15));
        log.push(`end${id}`);
        return { hash: `h${id}`, nonce: BigInt(id) };
      }),
    });
    const c = new NoirAgentClient({ sdk });
    const p = { agentSigner: signer("GA"), deviceHash: HASH, merchant: "GM", amount: 1n };
    await Promise.all([c.authorizePayment(p), c.authorizePayment(p), c.authorizePayment(p)]);
    expect(log).toEqual(["start1", "end1", "start2", "end2", "start3", "end3"]);
  });
});

describe("KeyedMutex", () => {
  it("runs different keys concurrently and continues after failure", async () => {
    const m = new KeyedMutex();
    const log: string[] = [];
    const a = m.run("a", async () => { await new Promise((r) => setTimeout(r, 20)); log.push("a"); });
    const b = m.run("b", async () => { log.push("b"); });
    await Promise.all([a, b]);
    expect(log).toEqual(["b", "a"]);
    await expect(m.run("a", async () => { throw new Error("x"); })).rejects.toThrow("x");
    await expect(m.run("a", async () => 5)).resolves.toBe(5);
  });
});

describe("reads and unlink", () => {
  it("passes through", async () => {
    const c = new NoirAgentClient({ sdk: mockSdk() });
    expect(await c.balanceOf(HASH)).toBe(42n);
    expect(await c.pendingBalance("GM")).toBe(9n);
    const u = await c.unlinkDevice(signer("GO"), HASH);
    expect(u.txs[1]).toEqual({ hash: "u2", explorerUrl: explorerTxUrl("u2") });
    expect(u.escrowReturned).toBe(5n);
  });
});
