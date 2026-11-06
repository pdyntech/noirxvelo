/**
 * Simulation mode: an in-memory stand-in for the Noir contracts, used when Testnet wallets are not
 * configured (or SIMULATE_CHAIN=1, or the operator switches to it after a Testnet failure).
 *
 * It implements the same SDK slice that packages/agent's NoirAgentClient wraps, with the same rules
 * the deployed contracts enforce (per-payment cap, registered agent, escrow balance, revoke), so the
 * executor, guardrail and recovery code run unchanged. Nothing here touches the network.
 * Every hash it returns starts with "sim" and the UI labels these transactions as simulated.
 */
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { NoirAgentClient, keypairSigner, type NoirSigner } from "@noirxvelo/agent";
import { toStroops } from "@noirxvelo/shared";

const LATENCY_MS = Number(process.env.SIM_LATENCY_MS ?? 450);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const simHash = () => `sim${randomBytes(30).toString("hex")}`;

/** Mirrors the shape of NoirContractError so packages/agent normalises it the same way. */
class SimContractError extends Error {
  constructor(
    message: string,
    readonly errorName: string,
    readonly code: number,
    readonly contract: string,
    readonly method: string,
  ) {
    super(message);
    this.name = "NoirContractError";
  }
}

type Policy = { agent: string; max: bigint; active: boolean; expiresAt: Date | null };

export class SimLedger {
  readonly wallets = new Map<string, bigint>();
  readonly devices = new Map<string, { owner: string; agent: string }>();
  readonly policies = new Map<string, Policy>();
  readonly escrow = new Map<string, bigint>();
  readonly pending = new Map<string, bigint>();

  balance(account: string): bigint {
    return this.wallets.get(account) ?? 0n;
  }
  private move(from: string | null, to: string | null, amount: bigint): void {
    if (from) {
      const b = this.balance(from);
      if (b < amount) throw new SimContractError("insufficient wallet balance", "InsufficientBalance", 10, "xlm_sac", "transfer");
      this.wallets.set(from, b - amount);
    }
    if (to) this.wallets.set(to, this.balance(to) + amount);
  }

  // ---- the SdkLike slice used by NoirAgentClient ----
  async execute(signer: NoirSigner, op: any): Promise<{ hash: string }> {
    await sleep(LATENCY_MS);
    if (op.kind === "registerDevice") {
      if (this.devices.has(op.deviceHash)) throw new SimContractError("already registered", "AlreadyRegistered", 4, "device_registry", "register");
      this.devices.set(op.deviceHash, { owner: signer.publicKey, agent: op.agent });
    } else if (op.kind === "registerAgent") {
      this.policies.set(op.deviceHash, { agent: op.agent, max: op.maxAmount, active: true, expiresAt: op.expiresAt ?? null });
    } else if (op.kind === "fundEscrow") {
      if (!this.devices.has(op.deviceHash)) throw new SimContractError("device not registered", "DeviceNotRegistered", 8, "payment_escrow", "fund_escrow");
      this.move(signer.publicKey, null, op.amount);
      this.escrow.set(op.deviceHash, (this.escrow.get(op.deviceHash) ?? 0n) + op.amount);
    } else {
      throw new Error(`simulation: unsupported op ${op.kind}`);
    }
    return { hash: simHash() };
  }

  async checkPayment(p: { deviceHash: string; agent: string; amount: bigint; requireEscrow?: boolean }): Promise<any> {
    const pol = this.policies.get(p.deviceHash);
    if (!pol || !pol.active || pol.agent !== p.agent) return { ok: false, reason: "wrong_agent" };
    if (pol.expiresAt && pol.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
    if (p.amount > pol.max) return { ok: false, reason: "over_limit" };
    if (p.requireEscrow && (this.escrow.get(p.deviceHash) ?? 0n) < p.amount) return { ok: false, reason: "insufficient_escrow" };
    return { ok: true };
  }

  async authorizePayment(p: { agent: NoirSigner; deviceHash: string; merchant: string; amount: bigint }): Promise<{ hash: string; nonce: bigint }> {
    await sleep(LATENCY_MS);
    const c = await this.checkPayment({ deviceHash: p.deviceHash, agent: p.agent.publicKey, amount: p.amount, requireEscrow: true });
    if (!c.ok) throw new SimContractError("simulation failed", "AgentNotAuthorized", 3, "payment_escrow", "authorize");
    this.escrow.set(p.deviceHash, (this.escrow.get(p.deviceHash) ?? 0n) - p.amount);
    this.pending.set(p.merchant, (this.pending.get(p.merchant) ?? 0n) + p.amount);
    return { hash: simHash(), nonce: BigInt(Date.now()) };
  }

  async claim(p: { merchant: NoirSigner }): Promise<{ hash: string }> {
    await sleep(LATENCY_MS);
    const v = this.pending.get(p.merchant.publicKey) ?? 0n;
    if (!v) throw new SimContractError("nothing to claim", "NothingToClaim", 5, "payment_escrow", "claim");
    this.pending.set(p.merchant.publicKey, 0n);
    this.move(null, p.merchant.publicKey, v);
    return { hash: simHash() };
  }

  async unlinkDevice(p: { owner: NoirSigner; deviceHash: string }): Promise<{ hashes: string[]; escrowReturned: bigint }> {
    await sleep(LATENCY_MS);
    const v = this.escrow.get(p.deviceHash) ?? 0n;
    const pol = this.policies.get(p.deviceHash);
    if (pol) pol.active = false;
    this.escrow.set(p.deviceHash, 0n);
    this.move(null, this.devices.get(p.deviceHash)?.owner ?? p.owner.publicKey, v);
    return { hashes: [simHash(), simHash()], escrowReturned: v };
  }

  async getEscrowBalance(deviceHash: string): Promise<bigint> {
    return this.escrow.get(deviceHash) ?? 0n;
  }
  async getPendingBalance(merchant: string): Promise<bigint> {
    return this.pending.get(merchant) ?? 0n;
  }
}

export type SimRole = "AGENT" | "SHIPOWNER" | "LP" | "TREASURY" | "DEBTOR";

/** Starting balances for the simulated wallets (XLM). */
const OPENING: Record<SimRole, string> = { TREASURY: "5000", LP: "5000", SHIPOWNER: "100", AGENT: "100", DEBTOR: "2000" };

export interface SimChain {
  ledger: SimLedger;
  client: NoirAgentClient;
  signers: Record<SimRole, NoirSigner>;
}

/** A fresh simulated chain with funded throwaway keypairs (generated locally, never on a network). */
export function createSimChain(): SimChain {
  const ledger = new SimLedger();
  const signers = Object.fromEntries(
    (Object.keys(OPENING) as SimRole[]).map((r) => [r, keypairSigner(Keypair.random().secret())]),
  ) as Record<SimRole, NoirSigner>;
  for (const r of Object.keys(OPENING) as SimRole[]) ledger.wallets.set(signers[r].publicKey, toStroops(OPENING[r]));
  const client = new NoirAgentClient({ sdk: ledger as any });
  return { ledger, client, signers };
}
