import { describe, it, expect, vi } from "vitest";
import { NoirContractError } from "@noirx402/agent-sdk";
import { toStroops } from "@noirxvelo/shared";
import { runGuardrail, guardrailHandler, type NoirSigner } from "../src/index.js";

const agent: NoirSigner = { publicKey: "G_AGENT", signTransaction: async (x) => x };
const opts = (sdkAuth: any, check: any = { ok: false, reason: "over_limit" }) => ({
  client: { asset: "C_XLM", checkPayment: vi.fn(async () => check), sdk: { authorizePayment: sdkAuth } } as any,
  deviceHash: "ab".repeat(32),
  agent,
  merchant: "G_SHIP",
});

describe("guardrail", () => {
  it("captures over_limit + NoirContractError fields", async () => {
    const o = opts(vi.fn(async () => { throw new NoirContractError("paymentEscrow", 3, "AgentNotAuthorized", "authorize"); }));
    const r = await runGuardrail(o);
    expect(r.checkPayment).toEqual({ ok: false, reason: "over_limit" });
    expect(r.sdkError).toMatchObject({ name: "NoirContractError", errorName: "AgentNotAuthorized", code: 3, contract: "paymentEscrow", method: "authorize" });
    expect(r.sdkError?.message).toContain("AgentNotAuthorized");
    expect(r.unexpectedSuccess).toBeNull();
    expect(r.summary).toMatch(/over_limit/);
    expect(o.client.checkPayment).toHaveBeenCalledWith({ deviceHash: o.deviceHash, agent: "G_AGENT", amount: toStroops("1000"), requireEscrow: true });
    expect(o.client.sdk.authorizePayment).toHaveBeenCalledWith(expect.objectContaining({ amount: toStroops("1000"), merchant: "G_SHIP", asset: "C_XLM" }));
  });
  it("plain Error gives nulls for chain fields", async () => {
    const r = await runGuardrail(opts(vi.fn(async () => { throw new Error("net down"); })));
    expect(r.sdkError).toEqual({ name: "Error", errorName: null, code: null, contract: null, method: null, message: "net down" });
  });
  it("reports loudly if SDK unexpectedly succeeds", async () => {
    const r = await runGuardrail(opts(vi.fn(async () => ({ hash: "HASH", nonce: 5n }))));
    expect(r.sdkError).toBeNull();
    expect(r.unexpectedSuccess).toEqual({ hash: "HASH", nonce: "5" });
    expect(r.summary).toMatch(/GUARDRAIL FAILURE/);
  });
  it("handler output is JSON-serialisable with no bigint", async () => {
    const out = await guardrailHandler(opts(vi.fn(async () => { throw new NoirContractError("paymentEscrow", 3, "AgentNotAuthorized", "authorize"); })));
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(out.attemptedStroops).toBe("10000000000");
    expect(out.capStroops).toBe("8800000000");
    expect(typeof out.ranAt).toBe("string");
  });
});
