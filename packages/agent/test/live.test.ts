import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { NoirAgentClient, keypairSigner, toStroops } from "../src/index.js";

const live = process.env.LIVE === "1";

describe.skipIf(!live)("live Testnet lifecycle", () => {
  it("register -> registerAgent -> fund -> check -> authorize -> claim", { timeout: 240_000 }, async () => {
    process.loadEnvFile(resolve(__dirname, "../../../.env.local"));
    const env = (k: string) => process.env[k]!;
    const treasury = keypairSigner(env("TREASURY_SECRET"));
    const lp = keypairSigner(env("LP_SECRET"));
    const agent = keypairSigner(env("AGENT_SECRET"));
    const shipowner = keypairSigner(env("SHIPOWNER_SECRET"));
    const c = new NoirAgentClient();
    const deviceHash = randomBytes(32).toString("hex");
    const links: Record<string, string> = {};

    links.registerDevice = (await c.registerDevice(treasury, deviceHash, env("AGENT_PUBLIC"))).explorerUrl;
    links.registerAgent = (await c.registerAgent(treasury, deviceHash, env("AGENT_PUBLIC"), toStroops("5"))).explorerUrl;
    links.fundEscrow = (await c.fundEscrow(lp, deviceHash, toStroops("2"))).explorerUrl;
    expect(await c.balanceOf(deviceHash)).toBe(toStroops("2"));
    expect(await c.checkPayment({ deviceHash, agent: env("AGENT_PUBLIC"), amount: toStroops("1"), requireEscrow: true })).toEqual({ ok: true });

    const over = await c.authorizePayment({ agentSigner: agent, deviceHash, merchant: env("SHIPOWNER_PUBLIC"), amount: toStroops("6") });
    expect(over).toEqual({ ok: false, refused: true, reason: "over_limit" });

    const auth = await c.authorizePayment({ agentSigner: agent, deviceHash, merchant: env("SHIPOWNER_PUBLIC"), amount: toStroops("1") });
    if (!auth.ok) throw new Error("unexpected refusal " + auth.reason);
    links.authorize = auth.explorerUrl;
    expect(typeof auth.nonce).toBe("bigint");
    expect(await c.pendingBalance(env("SHIPOWNER_PUBLIC"))).toBeGreaterThanOrEqual(toStroops("1"));

    links.claim = (await c.claim(shipowner)).explorerUrl;
    expect(await c.pendingBalance(env("SHIPOWNER_PUBLIC"))).toBe(0n);

    const dup = await c.registerDevice(treasury, deviceHash, env("AGENT_PUBLIC")).catch((e) => e);
    expect(dup.message).toBe("invoice already financed");

    const un = await c.unlinkDevice(treasury, deviceHash);
    links.unlink = un.txs.map((t) => t.explorerUrl).join(" ");
    console.log("LIVE LINKS", JSON.stringify(links, null, 1));
  });
});
