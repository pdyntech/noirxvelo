/**
 * AGT-01 (demo version): the settlement agent's decision policy.
 * The policy decides the decision kind from observed facts; amounts always come from computePayouts.
 * If LLM_API_KEY is set, an LLM writes the one-line reason (numbers are never taken from the model).
 * The executor in @noirxvelo/agent re-validates everything before any chain call.
 */
import { computePayouts, fromStroops } from "@noirxvelo/shared";
import type { AgentDecision } from "@noirxvelo/agent";
import { env } from "./env.js";

export interface Facts {
  invoiceId: string;
  faceValue: bigint;
  status: string;
  escrowFunded: boolean;
  vesselUnderway: boolean;
  berthed: boolean;
  paymentVerified: boolean;
  paymentAmountMatches: boolean;
  vessel: string;
  port: string;
}

export interface Proposal {
  decision: AgentDecision;
  engine: "rules" | "rules+llm";
}

const xlm = (s: bigint) => `${fromStroops(s)} XLM`;

/** Returns null when there is nothing to decide yet. */
export function propose(f: Facts): AgentDecision | null {
  const p = computePayouts(f.faceValue);
  if (f.status === "FUNDED" && f.escrowFunded && f.vesselUnderway) {
    return {
      invoiceId: f.invoiceId,
      decision: "ADVANCE",
      reason: `Waybill hash registered and ${f.vessel} is underway. Releasing the 85% advance (${xlm(p.advance)}) to the shipowner for bunker fuel and port dues.`,
      payouts: [{ role: "SHIPOWNER", amountStroops: p.advance.toString() }],
    };
  }
  if (f.status === "PAID") {
    if (!f.berthed || !f.paymentVerified || !f.paymentAmountMatches) {
      return {
        invoiceId: f.invoiceId,
        decision: "HOLD",
        reason: !f.berthed ? "Payment received but no berthing attestation yet; holding settlement." : "Payment not verified or amount does not match the invoice; holding settlement.",
        payouts: [],
      };
    }
    return {
      invoiceId: f.invoiceId,
      decision: "SETTLE",
      reason: `Berthing at ${f.port} attested and the debtor's ${xlm(f.faceValue)} Velo payment is verified. Repaying the LP ${xlm(p.lpRepayment)}, rebating ${xlm(p.rebate)} to the shipowner and ${xlm(p.fee)} to treasury.`,
      payouts: [
        { role: "LP", amountStroops: p.lpRepayment.toString() },
        { role: "SHIPOWNER", amountStroops: p.rebate.toString() },
        { role: "TREASURY", amountStroops: p.fee.toString() },
      ],
    };
  }
  return null;
}

/** Optional: let an LLM phrase the reason. Times out fast and falls back to the rules text. */
async function llmReason(d: AgentDecision, f: Facts): Promise<string | null> {
  const key = env("LLM_API_KEY");
  if (!key) return null;
  const facts = {
    decision: d.decision,
    vessel: f.vessel,
    port: f.port,
    vesselUnderway: f.vesselUnderway,
    berthed: f.berthed,
    paymentVerified: f.paymentVerified,
    payouts: d.payouts.map((p) => ({ role: p.role, xlm: fromStroops(BigInt(p.amountStroops)) })),
  };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        model: env("LLM_MODEL") ?? "claude-haiku-5-5",
        max_tokens: 120,
        messages: [
          {
            role: "user",
            content: `You are a freight-invoice settlement agent. In one plain sentence under 240 characters, explain this decision to an ops dashboard. Use only these facts and amounts, no new numbers:\n${JSON.stringify(facts)}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = j.content?.find((c) => c.type === "text")?.text?.trim();
    return text ? text.slice(0, 280) : null;
  } catch {
    return null;
  }
}

export async function decide(f: Facts): Promise<Proposal | null> {
  const d = propose(f);
  if (!d) return null;
  const r = await llmReason(d, f);
  return r ? { decision: { ...d, reason: r }, engine: "rules+llm" } : { decision: d, engine: "rules" };
}
