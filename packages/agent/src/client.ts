import { Asset, Networks } from "@stellar/stellar-sdk";
import { NoirAgentClient as SdkClient, type NoirSigner, type PaymentRefusal } from "@noirx402/agent-sdk";
import { ChainError, normalizeError } from "./errors.js";
import { KeyedMutex } from "./mutex.js";
import { txResult, type TxResult } from "./links.js";

export type { NoirSigner, PaymentRefusal };

/** Native XLM Stellar Asset Contract on Testnet. Default payment token. */
export const XLM_SAC = Asset.native().contractId(Networks.TESTNET);

/** Minimal slice of the SDK client this wrapper uses (lets tests inject a mock). */
export type SdkLike = Pick<
  SdkClient,
  | "execute"
  | "checkPayment"
  | "authorizePayment"
  | "claim"
  | "unlinkDevice"
  | "getEscrowBalance"
  | "getPendingBalance"
>;

export interface NoirAgentClientOptions {
  /** Inject an SDK client (tests). Defaults to a built-in TESTNET client. */
  sdk?: SdkLike;
  /** Default token/asset contract id. Defaults to the native XLM SAC. */
  asset?: string;
}

export interface CheckPaymentParams {
  deviceHash: string;
  agent: string;
  asset?: string;
  amount: bigint;
  requireEscrow?: boolean;
}

export type CheckResult = { ok: true } | { ok: false; reason: PaymentRefusal };

export interface AuthorizePaymentParams {
  agentSigner: NoirSigner;
  deviceHash: string;
  merchant: string;
  asset?: string;
  amount: bigint;
}

export type AuthorizeResult =
  | ({ ok: true; nonce: bigint } & TxResult)
  | { ok: false; refused: true; reason: PaymentRefusal };

export interface UnlinkResult {
  hashes: string[];
  txs: TxResult[];
  escrowReturned: bigint;
}

export class NoirAgentClient {
  readonly sdk: SdkLike;
  readonly asset: string;
  private readonly mutex = new KeyedMutex();

  constructor(opts: NoirAgentClientOptions = {}) {
    this.sdk = opts.sdk ?? new SdkClient();
    this.asset = opts.asset ?? XLM_SAC;
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw normalizeError(e);
    }
  }

  private async write(signer: NoirSigner, op: Parameters<SdkLike["execute"]>[1]): Promise<TxResult> {
    const { hash } = await this.wrap(() => this.sdk.execute(signer, op));
    return txResult(hash);
  }

  /** Register an invoice device. AlreadyRegistered surfaces as InvoiceAlreadyFinancedError. */
  registerDevice(treasurySigner: NoirSigner, deviceHash: string, agent: string): Promise<TxResult> {
    return this.write(treasurySigner, { kind: "registerDevice", deviceHash, agent });
  }

  registerAgent(
    treasurySigner: NoirSigner,
    deviceHash: string,
    agent: string,
    maxAmount: bigint,
    asset: string = this.asset,
    expiresAt: Date | null = null,
  ): Promise<TxResult> {
    return this.write(treasurySigner, { kind: "registerAgent", deviceHash, agent, asset, maxAmount, expiresAt });
  }

  /** Any funded wallet (owner or not, see spike S2) can fund. Token is the XLM SAC. */
  fundEscrow(funderSigner: NoirSigner, deviceHash: string, amount: bigint): Promise<TxResult> {
    return this.write(funderSigner, { kind: "fundEscrow", deviceHash, token: this.asset, amount });
  }

  checkPayment(p: CheckPaymentParams): Promise<CheckResult> {
    return this.wrap(() =>
      this.sdk.checkPayment({
        deviceHash: p.deviceHash,
        agent: p.agent,
        asset: p.asset ?? this.asset,
        amount: p.amount,
        requireEscrow: p.requireEscrow,
      }),
    );
  }

  /**
   * Pre-checks with checkPayment({requireEscrow:true}). On refusal returns the real reason
   * without sending (SDK authorize error is always the generic AgentNotAuthorized).
   * Calls are serialised per (deviceHash, agent) because nonces are ms timestamps.
   */
  authorizePayment(p: AuthorizeParamsAlias): Promise<AuthorizeResult> {
    const asset = p.asset ?? this.asset;
    const agent = p.agentSigner.publicKey;
    const key = `${p.deviceHash.toLowerCase()}:${agent}`;
    return this.mutex.run(key, async () => {
      const check = await this.checkPayment({
        deviceHash: p.deviceHash,
        agent,
        asset,
        amount: p.amount,
        requireEscrow: true,
      });
      if (!check.ok) return { ok: false as const, refused: true as const, reason: check.reason };
      const r = await this.wrap(() =>
        this.sdk.authorizePayment({
          agent: p.agentSigner,
          deviceHash: p.deviceHash,
          merchant: p.merchant,
          asset,
          amount: p.amount,
        }),
      );
      return { ok: true as const, nonce: r.nonce, ...txResult(r.hash) };
    });
  }

  /** Pays out everything pending for this merchant in the XLM token, across all devices. */
  claim(merchantSigner: NoirSigner): Promise<TxResult> {
    return this.wrap(async () => txResult((await this.sdk.claim({ merchant: merchantSigner, token: this.asset })).hash));
  }

  balanceOf(deviceHash: string): Promise<bigint> {
    return this.wrap(() => this.sdk.getEscrowBalance(deviceHash));
  }

  pendingBalance(merchant: string): Promise<bigint> {
    return this.wrap(() => this.sdk.getPendingBalance(merchant));
  }

  /** Safe revoke + sweep: escrow returns to the device owner. */
  async unlinkDevice(ownerSigner: NoirSigner, deviceHash: string): Promise<UnlinkResult> {
    const r = await this.wrap(() => this.sdk.unlinkDevice({ owner: ownerSigner, deviceHash }));
    return { hashes: r.hashes, txs: r.hashes.map(txResult), escrowReturned: r.escrowReturned };
  }
}

type AuthorizeParamsAlias = AuthorizePaymentParams;
export { ChainError };
