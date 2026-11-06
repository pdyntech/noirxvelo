import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { toStroops, computePayouts } from "@noirxvelo/shared";
import { NoirAgentClient, keypairSigner, execute, runGuardrail, type ExecutorContext, type AgentDecision } from "../src/index.js";

const live = process.env.LIVE === "1";

describe.skipIf(!live)("live executor + guardrail", () => {
  it("ADVANCE -> Treasury funds V -> SETTLE (880/115/5, escrow 0) -> guardrail", { timeout: 600_000 }, async () => {
    process.loadEnvFile(resolve(__dirname, "../../../.env.local"));
    const env = (k: string) => process.env[k]!;
    const treasury = keypairSigner(env("TREASURY_SECRET"));
    const lp = keypairSigner(env("LP_SECRET"));
    const agent = keypairSigner(env("AGENT_SECRET"));
    const shipowner = keypairSigner(env("SHIPOWNER_SECRET"));
    const c = new NoirAgentClient();
    const deviceHash = randomBytes(32).toString("hex");
    const V = toStroops("1000");
    const P = computePayouts(V);
    const links: Record<string, string> = {};

    links.registerDevice = (await c.registerDevice(treasury, deviceHash, env("AGENT_PUBLIC"))).explorerUrl;
    links.registerAgent = (await c.registerAgent(treasury, deviceHash, env("AGENT_PUBLIC"), P.maxAmount)).explorerUrl;
    links.fundLP = (await c.fundEscrow(lp, deviceHash, P.advance)).explorerUrl;

    const ctx: ExecutorContext = {
      client: c,
      invoice: { id: "INV-2026-001", state: "FUNDED", faceValue: V },
      deviceHash,
      addresses: { SHIPOWNER: env("SHIPOWNER_PUBLIC"), LP: env("LP_PUBLIC"), TREASURY: env("TREASURY_PUBLIC") },
      signers: { AGENT: agent, SHIPOWNER: shipowner, LP: lp, TREASURY: treasury },
      gates: { hashRegisteredByUs: true, vesselUnderway: true, webhookVerified: true, berthingAttestation: true },
    };

    const adv: AgentDecision = { invoiceId: "INV-2026-001", decision: "ADVANCE", reason: "live test", payouts: [{ role: "SHIPOWNER", amountStroops: P.advance.toString() }] };
    const a = await execute(adv, ctx);
    expect(a).toMatchObject({ decision: "ADVANCE", ok: true, finalEscrowBalance: 0n });
    a.steps.forEach((s) => (links[`advance.${s.step}`] = s.explorerUrl));

    links.fundTreasury = (await c.fundEscrow(treasury, deviceHash, V)).explorerUrl; // emulates the Velo bridge
    expect(await c.balanceOf(deviceHash)).toBe(V);

    const set: AgentDecision = {
      invoiceId: "INV-2026-001",
      decision: "SETTLE",
      reason: "live test",
      payouts: [
        { role: "LP", amountStroops: P.lpRepayment.toString() },
        { role: "SHIPOWNER", amountStroops: P.rebate.toString() },
        { role: "TREASURY", amountStroops: P.fee.toString() },
      ],
    };
    const s = await execute(set, { ...ctx, invoice: { ...ctx.invoice, state: "PAID" } });
    expect(s).toMatchObject({ decision: "SETTLE", ok: true, finalEscrowBalance: 0n });
    expect(s.steps.filter((x) => x.step === "authorize").map((x) => x.amount)).toEqual([toStroops("880"), toStroops("115"), toStroops("5")]);
    s.steps.forEach((x) => (links[`settle.${x.step}.${x.role}`] = x.explorerUrl));
    expect(await c.balanceOf(deviceHash)).toBe(0n);

    const g = await runGuardrail({ client: c, deviceHash, agent, merchant: env("SHIPOWNER_PUBLIC") });
    expect(g.checkPayment).toEqual({ ok: false, reason: "over_limit" });
    console.log("GUARDRAIL", JSON.stringify(g, null, 1));
    expect(g.unexpectedSuccess).toBeNull();
    expect(g.sdkError?.errorName).toBe("AgentNotAuthorized");

    console.log("LIVE LINKS", JSON.stringify(links, null, 1));
  });
});
