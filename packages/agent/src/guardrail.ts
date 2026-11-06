/**
 * AGT-03: over-limit guardrail demo (PRD §3.4, §10.3; spike S8).
 * Proof line 1: checkPayment -> { ok:false, reason:'over_limit' } (wrapper, read-only, no fee).
 * Proof line 2: the raw SDK authorizePayment stops at simulation with NoirContractError
 *   (AgentNotAuthorized #3, no tx, no fee). The reason must NOT be derived from this error.
 * This is the only place outside client.ts that touches client.sdk directly.
 */
import { toStroops, fromStroops } from "@noirxvelo/shared";
import type { CheckResult, NoirAgentClient, NoirSigner } from "./client.js";

export interface GuardrailOptions {
  client: Pick<NoirAgentClient, "checkPayment" | "sdk" | "asset">;
  deviceHash: string;
  /** Agent signer (public key is the policy's registered agent). */
  agent: NoirSigner;
  /** Payee for the attempted payout (e.g. SHIPOWNER address). */
  merchant: string;
  /** Registered policy cap in stroops. Default 880 XLM. Used for the summary only. */
  capAmount?: bigint;
  /** Amount attempted in stroops. Default 1000 XLM. */
  attemptAmount?: bigint;
}

export interface SdkErrorProof {
  name: string;
  errorName: string | null;
  code: number | null;
  contract: string | null;
  method: string | null;
  message: string;
}

export interface GuardrailResult {
  checkPayment: CheckResult;
  /** Null only if the raw SDK call unexpectedly succeeded (see `unexpectedSuccess`). */
  sdkError: SdkErrorProof | null;
  /** Set (loudly) if the over-limit authorize was NOT stopped by the SDK. */
  unexpectedSuccess: { hash: string; nonce: string } | null;
  attemptedStroops: string;
  capStroops: string;
  summary: string;
}

export async function runGuardrail(o: GuardrailOptions): Promise<GuardrailResult> {
  const cap = o.capAmount ?? toStroops("880");
  const attempt = o.attemptAmount ?? toStroops("1000");
  const agentPub = o.agent.publicKey;

  const check = await o.client.checkPayment({
    deviceHash: o.deviceHash,
    agent: agentPub,
    amount: attempt,
    requireEscrow: true,
  });

  let sdkError: SdkErrorProof | null = null;
  let unexpectedSuccess: GuardrailResult["unexpectedSuccess"] = null;
  try {
    const r = await o.client.sdk.authorizePayment({
      agent: o.agent,
      deviceHash: o.deviceHash,
      merchant: o.merchant,
      asset: o.client.asset,
      amount: attempt,
    });
    unexpectedSuccess = { hash: r.hash, nonce: r.nonce.toString() };
  } catch (e) {
    const x = e as Record<string, unknown> | null;
    const str = (k: string) => (x && typeof x[k] === "string" ? (x[k] as string) : null);
    sdkError = {
      name: e instanceof Error ? e.name : "Error",
      errorName: str("errorName"),
      code: x && typeof x.code === "number" ? x.code : null,
      contract: str("contract"),
      method: str("method"),
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const amt = `${fromStroops(attempt)} XLM`;
  const capTxt = `${fromStroops(cap)} XLM`;
  let summary: string;
  if (unexpectedSuccess) {
    summary = `!!! GUARDRAIL FAILURE: ${amt} payout vs ${capTxt} cap was NOT refused by the SDK; authorize landed in tx ${unexpectedSuccess.hash}. checkPayment said ${JSON.stringify(check)}.`;
  } else if (!check.ok) {
    summary = `Refused: ${amt} payout vs ${capTxt} cap. checkPayment -> ${check.reason}; SDK stopped at simulation (${sdkError?.errorName ?? sdkError?.name}${sdkError?.code != null ? ` #${sdkError.code}` : ""}). No transaction sent, no fee.`;
  } else {
    summary = `Unexpected: checkPayment returned ok for ${amt} vs ${capTxt} cap, but the SDK still refused (${sdkError?.errorName ?? sdkError?.name}). Check the policy cap.`;
  }

  return {
    checkPayment: check,
    sdkError,
    unexpectedSuccess,
    attemptedStroops: attempt.toString(),
    capStroops: cap.toString(),
    summary,
  };
}

/** Plain JSON-serialisable payload (bigint as strings) for apps/server to mount, e.g. res.json(await guardrailHandler(opts)). */
export async function guardrailHandler(o: GuardrailOptions): Promise<GuardrailResult & { ranAt: string }> {
  const r = await runGuardrail(o);
  return JSON.parse(JSON.stringify({ ...r, ranAt: new Date().toISOString() }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
