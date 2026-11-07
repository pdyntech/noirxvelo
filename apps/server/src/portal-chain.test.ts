import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "sailo-chain-"));
// Valid platform wallets, so chainAvailable() is true. No network is used in these tests.
for (const r of ["TREASURY", "SHIPOWNER", "LP", "AGENT"]) {
  const kp = Keypair.random();
  process.env[`${r}_PUBLIC`] = kp.publicKey();
  process.env[`${r}_SECRET`] = kp.secret();
}
delete process.env.SIMULATE_CHAIN;
delete process.env.KV_REST_API_URL;
delete process.env.REDIS_URL;

const { db } = await import("./db.js");
const { withLock } = await import("./kv.js");
const chain = await import("./portal-chain.js");
const { decryptSecret, encryptSecret } = await import("./wallets.js");
type Inv = (typeof db.invoices)[number];

function inv(state: Inv["state"], c: Partial<NonNullable<Inv["chain"]>> = {}): Inv {
  return {
    seq: 1, id: "INV-2026-001", hash: "a".repeat(64), createdAt: "", vessel: "MV T", route: "Manila to Cebu", port: "Port of Cebu",
    debtor: "D", debtorEmail: null, ownerId: "u1", ownerName: "O", funderId: null, funderName: null, face: 100_000, term: 30,
    state, holdFrom: null, stateAt: Date.now(), paidAmount: null, berthAttested: false, sampleFor: null, simInvestor: false, simDebtor: true, log: [],
    chain: { ...chain.newChain(), ...c },
  };
}

describe("wallet secrets", () => {
  it("round-trips and is not stored in the clear", () => {
    const s = Keypair.random().secret();
    const enc = encryptSecret(s);
    expect(enc).not.toContain(s);
    expect(decryptSecret(enc)).toBe(s);
  });
  it("rejects a tampered secret", () => {
    const enc = encryptSecret(Keypair.random().secret());
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});

describe("portal chain steps", () => {
  it("picks the step each state waits for", () => {
    expect(chain.jobFor(inv("TOKENIZED"))).toBe("register");
    expect(chain.jobFor(inv("TOKENIZED", { registered: true }))).toBeNull();
    expect(chain.jobFor(inv("TOKENIZED", { registered: true, fundRequest: { userId: "u2", at: 0 } }))).toBe("fund");
    expect(chain.jobFor(inv("FUNDED"))).toBe("advance");
    expect(chain.jobFor(inv("IN_TRANSIT"))).toBeNull();
    expect(chain.jobFor(inv("BERTHED"))).toBeNull();
    const paid = { verified: true, eventId: "e", amountXlm: "100", amountMatches: true, verifiedBy: "x", simulated: true, at: "" };
    expect(chain.jobFor(inv("BERTHED", { payment: paid }))).toBe("payin");
    expect(chain.jobFor(inv("PAID"))).toBe("settle");
    expect(chain.jobFor(inv("SETTLED"))).toBeNull();
    expect(chain.jobFor(inv("HOLD"))).toBeNull();
    expect(chain.jobFor({ ...inv("FUNDED"), chain: null })).toBeNull();
  });

  it("never starts a step that another instance is running, and backs off after errors", () => {
    db.invoices = [inv("FUNDED", { job: { step: "advance", by: "other", at: Date.now(), fromState: "FUNDED" } })];
    expect(chain.dueJobs()).toEqual([]);
    db.invoices = [inv("FUNDED", { job: { step: "advance", by: "other", at: Date.now() - 10 * 60_000, fromState: "FUNDED" } })];
    expect(chain.dueJobs()).toEqual(["INV-2026-001"]); // stale job: its instance is gone
    db.invoices = [inv("FUNDED", { error: "boom", attempts: 1, lastErrorAt: Date.now() })];
    expect(chain.dueJobs()).toEqual([]); // waits before retrying
    db.invoices = [inv("FUNDED", { error: "boom", attempts: 1, lastErrorAt: Date.now() - 60_000 })];
    expect(chain.dueJobs()).toEqual(["INV-2026-001"]);
    const stuck = inv("FUNDED", { error: "boom", attempts: 3, lastErrorAt: 0 });
    db.invoices = [stuck];
    expect(chain.dueJobs()).toEqual([]); // after 3 failures, a person presses Retry
    expect(chain.needsRetry(stuck)).toBe(true);
    chain.resetRetry(stuck);
    expect(chain.dueJobs()).toEqual(["INV-2026-001"]);
  });

  it("signs the berthing proof with the agent key", () => {
    const a = chain.signBerthing(inv("IN_TRANSIT"))!;
    expect(a.signer).toBe(process.env.AGENT_PUBLIC);
    expect(Keypair.fromPublicKey(a.signer).verify(Buffer.from(a.sha256, "hex"), Buffer.from(a.signature, "base64"))).toBe(true);
  });
});

describe("withLock without a shared store", () => {
  it("runs holders of the same lock one at a time", async () => {
    const order: string[] = [];
    const job = (n: string, ms: number) => withLock("t", async () => {
      order.push(`start ${n}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end ${n}`);
    });
    await Promise.all([job("a", 30), job("b", 5), job("c", 1)]);
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });
});
