# Work log: thanreiz (blockchain lane)

Times are Philippine time (UTC+8), Fri Nov 6, 2026. Source: merged PRs and commit history on `main`.

## Summary
- **10 issues closed:** #2, #4, #5, #6, #7, #8, #9, #15, #16, #23.
- **6 PRs merged:** #26 to #31, about 1h10m from first merge to last (20:45 to 21:53).
- **Live Testnet proof:** spikes S2/S3/S8, the full lifecycle, the executor ADVANCE and SETTLE flow, the guardrail refusal, and default recovery. Links are in `docs/spikes.md` and `docs/testnet-proof.md`.
- **Tests:** 70 passing on `main`, `tsc` clean. Live tests run with `LIVE=1`.
- **Handoff issue for the team:** #32.

## Timeline

| Time | PR | Issues | What was delivered |
| --- | --- | --- | --- |
| 20:45 | [#26](https://github.com/pdyntech/noirxvelo/pull/26) | #2, #6, #9 | Spike S1 findings in `docs/spikes.md`. Monorepo workspace root (pins: `@stellar/stellar-sdk` 16.4.1, `.nvmrc` 24.22.1). `scripts/provision.ts` funds 6 Testnet wallets. `packages/shared`: canonical sha256 waybill hashing, store with duplicate and webhook de-dupe, seed data, bigint payout math. |
| 21:12 | [#27](https://github.com/pdyntech/noirxvelo/pull/27) | #4, #5 | Live spikes. **S2:** a non-owner (LP) can fund escrow. **S3:** a duplicate `registerDevice` is rejected on-chain (`AlreadyRegistered`). **S8:** `checkPayment` returns `over_limit` before any fee; direct over-cap `authorizePayment` is stopped at simulation. Added `@noirx402/agent-sdk` 0.3.0. |
| 21:23 | [#28](https://github.com/pdyntech/noirxvelo/pull/28) | #7 | `packages/agent` Noir client wrapper: SDK-only, `checkPayment` pre-check, per-(device, agent) mutex, typed `ChainError`, explorer links. |
| 21:31 | [#29](https://github.com/pdyntech/noirxvelo/pull/29) | #8 | `scripts/lifecycle.ts`: register, policy, fund 850, check, authorize 850, claim. Escrow 0, Shipowner +849.9989932 XLM. Proof in `docs/testnet-proof.md`. |
| 21:44 | [#30](https://github.com/pdyntech/noirxvelo/pull/30) | #15, #16 | `executor.ts`: decision validation, payout recompute, gates, HOLD on any refusal, ADVANCE and 3-payout SETTLE. `guardrail.ts`: `over_limit` plus the captured SDK error, JSON handler. |
| 21:53 | [#31](https://github.com/pdyntech/noirxvelo/pull/31) | #23 | `recovery.ts`: revoke agent and sweep escrow to Treasury (850 to 0, Treasury +849.9978 XLM); revoked agent refused with `no_agent`. `DEFAULT` gate in the executor. |

## Key findings worth remembering
- The SDK has no `registerDevice` or `fundEscrow` methods; everything goes through `execute(signer, op)`.
- The SDK's authorize error is always `AgentNotAuthorized (#3)`. The real refusal reason comes from `checkPayment`.
- `claim` pays all pending for a merchant across devices in one tx.
- Escrow refunds on unlink go to the device owner (Treasury), not the funder.
- Node below 24.22.1 silently installs the retired SDK 0.2.0.

## Still open (other owners)
Executor wiring to #11, #13, #14; server mount for the guardrail (#21); full E2E run (#22); README (#24). See issue #32.
