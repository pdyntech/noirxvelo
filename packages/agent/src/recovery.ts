/**
 * EXT-01: Default recovery (PRD §7.2, §8.1, §10.2). Ops-triggered only, never from the LLM decision.
 * Safe order via the wrapper's unlinkDevice (revokeAgent + sweepOnRevoke), then proves the revoked
 * agent is halted. Never revokeDevice with escrow left (docs/spikes.md S1).
 */
import { fromStroops } from "@noirx402/agent-sdk";
import type { NoirAgentClient, NoirSigner, PaymentRefusal } from "./client.js";
import type { TxResult } from "./links.js";

export type RecoveryClient = Pick<NoirAgentClient, "unlinkDevice" | "balanceOf" | "checkPayment" | "authorizePayment">;

export interface DefaultRecoveryParams {
  client: RecoveryClient;
  /** Device owner (Treasury). Escrow is swept back to this account. */
  ownerSigner: NoirSigner;
  deviceHash: string;
  /** The agent whose policy is revoked. Signer is needed to prove authorizePayment is refused. */
  agent: NoirSigner;
  /** Treasury native XLM balance in stroops. Defaults to Horizon testnet. */
  readTreasuryBalance?: (account: string) => Promise<bigint>;
  /** Merchant used for the post-revoke authorize probe. Defaults to the owner. */
  probeMerchant?: string;
}

export interface DefaultRecoveryResult {
  hashes: string[];
  txs: TxResult[];
  escrowBefore: bigint;
  escrowReturned: bigint;
  escrowAfter: bigint;
  treasuryBefore: bigint;
  treasuryAfter: bigint;
  /** Refusal returned by checkPayment after revoke (expected "no_agent"). */
  checkAfterRevoke: PaymentRefusal;
  /** authorizePayment after revoke was refused locally, nothing sent. */
  authorizeRefused: PaymentRefusal;
}

const HORIZON = "https://horizon-testnet.stellar.org";

export async function horizonXlmBalance(account: string): Promise<bigint> {
  const res = await fetch(`${HORIZON}/accounts/${account}`);
  if (!res.ok) throw new Error(`horizon ${res.status} for ${account}`);
  const j = (await res.json()) as { balances: { asset_type: string; balance: string }[] };
  const n = j.balances.find((b) => b.asset_type === "native");
  if (!n) throw new Error("no native balance");
  const [whole, frac = ""] = n.balance.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0").slice(0, 7));
}

export class RecoveryError extends Error {
  constructor(message: string, readonly partial?: Partial<DefaultRecoveryResult>) {
    super(message);
    this.name = "RecoveryError";
  }
}

export async function defaultRecovery(p: DefaultRecoveryParams): Promise<DefaultRecoveryResult> {
  const { client, ownerSigner, deviceHash, agent } = p;
  const readBal = p.readTreasuryBalance ?? horizonXlmBalance;
  const treasury = ownerSigner.publicKey;

  const escrowBefore = await client.balanceOf(deviceHash);
  const treasuryBefore = await readBal(treasury);

  const unlink = await client.unlinkDevice(ownerSigner, deviceHash);

  const escrowAfter = await client.balanceOf(deviceHash);
  const treasuryAfter = await readBal(treasury);
  const base = { hashes: unlink.hashes, txs: unlink.txs, escrowBefore, escrowReturned: unlink.escrowReturned, escrowAfter, treasuryBefore, treasuryAfter };
  if (escrowAfter !== 0n) {
    throw new RecoveryError(`escrow not empty after sweep: ${fromStroops(escrowAfter)} XLM left`, base);
  }

  // Prove the revoked agent is halted. 1 stroop minimum so a zero-escrow device is still probed.
  const amount = escrowBefore > 0n ? escrowBefore : 1n;
  const check = await client.checkPayment({ deviceHash, agent: agent.publicKey, amount });
  if (check.ok) throw new RecoveryError("checkPayment still ok after revoke", base);
  const auth = await client.authorizePayment({
    agentSigner: agent,
    deviceHash,
    merchant: p.probeMerchant ?? treasury,
    amount,
  });
  if (auth.ok) throw new RecoveryError("authorizePayment succeeded after revoke", base);

  return { ...base, checkAfterRevoke: check.reason, authorizeRefused: auth.reason };
}
