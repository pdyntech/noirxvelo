# Spikes

## S1: Noir SDK signatures and config (issue #2)

Verified by installing `@noirx402/agent-sdk@0.3.0` and reading `dist/*.d.ts` and `dist/client.js`. Not yet exercised on-chain (that is #5, #4, #8).

### Install gotcha (read first)

- **Pin `@noirx402/agent-sdk@0.3.0` exactly.** `0.2.0` is deprecated and points at the retired contracts.
- 0.3.0 declares `engines.node: ^22.23.4 || ^24.22.1 || >=26.12.1`. On an older Node (for example 24.15.0), `npm install @noirx402/agent-sdk` silently resolves to **0.2.0**. Check `npm ls @noirx402/agent-sdk` after installing.
- Use Node >= 24.22.1 (or 22.23.4+). Set `engines` and `.nvmrc` at the repo root.
- `@stellar/stellar-sdk` resolved to 16.4.1.

### Contract IDs

`TESTNET` is exported from the SDK (`dist/networks.js`) and matches PRD section 10.1 exactly:

| Key | ID |
| --- | --- |
| `deviceRegistry` | `CAC4KOLHDLDYDWBOKXNKRN5KVHO56PLOIFXDLTBUWGVN6GVDEB7FQHU5` |
| `agentRegistry` | `CCMZDSPTLX7IIJWCYEUM5DJUHOSOYSTHGK777S2TXZWEMC5ZZGPJ3EBV` |
| `paymentEscrow` | `CC7EAW5FNJEDBS7THM5IT6XIOHO4AOYMLXT3KSZ3HWUIKEACTW7E5BFS` |

`new NoirAgentClient()` defaults to Testnet. Do not hardcode IDs.

### Real API differs from the issue text

The SDK has **no** `registerDevice`, `registerAgent`, `fundEscrow` or `revokeAgent` methods on the client. All device-owner writes go through one generic call:

```ts
client.execute(signer: NoirSigner, op: NoirOperation): Promise<{ hash: string }>
```

The acting account is the signer: the agent for `authorize`, the merchant for `claim`, the device owner for the rest.

```ts
type NoirOperation =
  | { kind: 'registerDevice'; deviceHash: string; agent: string }
  | { kind: 'revokeDevice'; deviceHash: string }
  | { kind: 'registerAgent'; deviceHash: string; agent: string; asset: string; maxAmount: bigint; expiresAt?: Date | null }
  | { kind: 'revokeAgent'; deviceHash: string }
  | { kind: 'fundEscrow'; deviceHash: string; token: string; amount: bigint }
  | { kind: 'defundEscrow'; deviceHash: string; token: string; amount: bigint }
  | { kind: 'sweepOnRevoke'; deviceHash: string; token: string; agent: string }
  | { kind: 'authorize'; deviceHash: string; merchant: string; asset: string; amount: bigint; nonce: bigint }
  | { kind: 'claim'; token: string };
```

Dedicated methods:

```ts
checkPayment(p: { deviceHash; agent; asset; amount: bigint; requireEscrow?: boolean }): Promise<{ ok: true } | { ok: false; reason: PaymentRefusal }>
// PaymentRefusal = 'no_agent' | 'wrong_agent' | 'wrong_asset' | 'invalid_amount' | 'over_limit' | 'expired' | 'insufficient_escrow'

authorizePayment(p: { agent: NoirSigner; deviceHash; merchant; asset; amount: bigint; nonce?: bigint }): Promise<{ hash: string; nonce: bigint }>
claim(p: { merchant: NoirSigner; token: string }): Promise<{ hash: string }>
unlinkDevice(p: { owner: NoirSigner; deviceHash }): Promise<{ hashes: string[]; escrowReturned: bigint }>

// reads (no account needed)
getPolicy(deviceHash): Promise<{ agent; maxAmount: bigint; asset; expiresAt: Date | null } | null>
getDeviceOwner(deviceHash): Promise<string | null>
getDeviceAgent(deviceHash): Promise<string | null>
listDevices(wallet): Promise<string[]>
getEscrowBalance(deviceHash): Promise<bigint>
getEscrowToken(deviceHash): Promise<string | null>
getPendingBalance(merchant): Promise<bigint>

// events
watch({ onEvent, onError?, types?, deviceHash?, merchant?, fromLedger?, pollMs? }): () => void
getEvents(...), pastEvents(fromLedger)
// low-level (browser or remote signing)
prepare(source, op): Promise<string>; submit(signedXdr, op?): Promise<string>
```

Helpers exported: `keypairSigner(secret)`, `toStroops`, `fromStroops`, `normalizeDeviceHash`, `NoirContractError` (`errorName`, `contract`, `method`, `code`), `refusalReason`, `startWebhookRelay`, `verifyWebhookSignature`.

Mapping for `packages/agent` (issue #7), so wrapper names stay stable:

| Wrapper (issue #7) | SDK call |
| --- | --- |
| `registerDevice(hash, agent)` | `execute(treasury, { kind: 'registerDevice', deviceHash, agent })` |
| `registerAgent(...)` | `execute(treasury, { kind: 'registerAgent', ... })` |
| `fundEscrow(funder, hash, amt)` | `execute(funder, { kind: 'fundEscrow', deviceHash, token, amount })` (**S2: confirm a non-owner funder works**) |
| `checkPayment` | `checkPayment` (use `requireEscrow: true` before paying) |
| `authorizePayment` | `authorizePayment` |
| `claim(merchant)` | `claim({ merchant, token })` (needs the token contract ID, not just the signer) |
| `balanceOf(hash)` | `getEscrowBalance` |
| `pendingBalance(addr)` | `getPendingBalance` |
| revoke and sweep (P1, #23) | `unlinkDevice` (safe order) or `execute` with `revokeAgent` and `sweepOnRevoke` |

### Nonces

SDK-managed. `authorizePayment` defaults `nonce` to milliseconds since epoch, which must increase per (device, agent). No caller sequence is needed, but **serialise calls per (device, agent)** so two payments in the same millisecond cannot collide. Store the returned `{ hash, nonce }` per step (PRD section 10.5).

### Notes for later spikes

- `fundEscrow` passes the signer as the `from` wallet (`toCall`: `[token, source, deviceHash, amount]`). That suggests a non-owner (the LP) can fund, but only a live call settles S2 (#5).
- The escrow token is bound by the first `fundEscrow` (`getEscrowToken`). Always use the native XLM SAC: `Asset.native().contractId(Networks.TESTNET)`.
- `checkPayment` mirrors `agent_registry.check_payment` and adds an escrow check. `over_limit` is returned before any fee is paid, which supports the PRD's S8 fallback.
- Never `revokeDevice` while escrow remains. Use `unlinkDevice`.
- `deviceHash` is normalised to lowercase hex. Use `sha256(canonical_waybill_json)` as 64-char hex. S3 (duplicate hash) is still open.

## S2: Can a non-owner (LP) fund a Treasury-owned device's escrow? (issue #5)

Script: `scripts/spikes/s2-s3.ts` (`npx tsx scripts/spikes/s2-s3.ts`). Run live on Testnet, serialised, fresh random 64-hex `deviceHash`, native XLM SAC as token.

**Result: yes.** After Treasury `registerDevice` + `registerAgent` (cap 880 XLM), the LP wallet (not the device owner) called `execute(lp, { kind: 'fundEscrow', ... })` with 100 XLM. It succeeded and `getEscrowBalance` returned `1000000000n` (100 XLM, 7 decimals). No routing via Treasury is needed.

- LP fund tx: [a6397b5c...](https://stellar.expert/explorer/testnet/tx/a6397b5c398bcbaa09f4af143280952a15b9b2b7f7cb5acddbcbe95b77a3b8cc) (run 1), [273b1ad3...](https://stellar.expert/explorer/testnet/tx/273b1ad3d0670f4458511905235d7da012a1b898aa73673701ebdd890eaa186c) (run 2).
- Setup (run 2): registerDevice [9c312c9c...](https://stellar.expert/explorer/testnet/tx/9c312c9c7b3f7e667c0e67f6506029a6ec2e511b08331fab37f36c5ae1abdd61), registerAgent [11e4bd16...](https://stellar.expert/explorer/testnet/tx/11e4bd16618a9205bea426f3d718b88299316dd1c1a1d76d994502f64022d092).
- **Token binding:** first `fundEscrow` binds the token. `getEscrowToken` returned the XLM SAC (`CDLZFC3S...GCYSC`). A second `fundEscrow` by the LP with a different token contract was rejected: `NoirContractError` `errorName: 'InvalidAsset'`, code 9, `paymentEscrow.fund_escrow`; balance unchanged.
- **Funds flow:** the LP's XLM leaves the LP wallet and sits in the device escrow. `unlinkDevice` (owner = Treasury) returns the whole escrow to the **owner (Treasury)**, not to the funder. Funder is not recorded on-chain as a claimant.

### Claim semantics (issue #5 item 2)

Two devices (A, B), both Treasury-owned, same merchant (SHIPOWNER). Agent authorised 5 XLM on B and 10 XLM on A. `getPendingBalance(SHIPOWNER)` = 15 XLM (`150000000n`). One `claim({ merchant, token: XLM })` set pending to `0n`. **`claim` pays everything pending for that merchant in that token across all devices**, in one tx.

- authorize B 5 XLM: [1da26b7d...](https://stellar.expert/explorer/testnet/tx/1da26b7dfd380b5469b0041f97bb5ac8dbda807fb152d61b2f462172db37d76a)
- authorize A 10 XLM: [09188a90...](https://stellar.expert/explorer/testnet/tx/09188a903d91bd7655e6343f48817b2a5bb52b20bc2f9cc7e6fb1a34befcfdfe)
- claim: [a36a7e88...](https://stellar.expert/explorer/testnet/tx/a36a7e8811fc3057898ac56d9ac4ca8ac46ef0b930c7b5ccc54e022e398d0a89)

### Happy path confirmed

`fundEscrow` (LP) -> `checkPayment({ requireEscrow: true })` returned `{ ok: true }` -> `authorizePayment` (agent signs; pending +10 XLM, escrow -10 XLM) -> `claim` (merchant signs; pending 0). Run 1 tx: authorize [8773584c...](https://stellar.expert/explorer/testnet/tx/8773584c5fad040b303103cac79d95d2a35711428689d318e298a91cda875b7e), claim [38173f26...](https://stellar.expert/explorer/testnet/tx/38173f26d360eaefcf1b0cf24bd56bed11c7d0e0d4e5ff557d0df2b90861a4e3).

Note: `authorize` only moves escrow to the merchant's pending balance; funds reach the merchant wallet only on `claim`. The demo must show the claim step (or auto-claim with the merchant key) to show money landing.

### Recommendation (PRD fallback)

Use the primary design: LP funds the invoice device's escrow directly. The "route via Treasury" fallback is **not needed**. Keep the token pinned to the XLM SAC. Expect refunds on unlink to go to Treasury, so a Treasury-to-LP return (if wanted) is a separate plain payment.

## S3: Duplicate `registerDevice` with the same `deviceHash` (issue #5)

Script: same `scripts/spikes/s2-s3.ts`, run after the device was registered, funded and used.

**Result: rejected on-chain, no overwrite.**

| Attempt | Signer | Outcome |
| --- | --- | --- |
| `registerDevice` same hash, same agent | Treasury (same owner) | `NoirContractError`, `deviceRegistry.register`, `errorName: 'AlreadyRegistered'`, code 4 |
| `registerDevice` same hash | LP (different owner) | same: `AlreadyRegistered`, code 4 |
| `registerAgent` again (new cap 1 XLM) | Treasury | `agentRegistry.register_agent`, `AlreadyRegistered`, code 3; policy still 880 XLM |

Both rejections happen at **simulation** (no tx submitted, no fee). Owner after the attempts was still Treasury. A policy cannot be overwritten by calling `registerAgent` again; change a cap via `revokeAgent` then `registerAgent`.

Error shape is the same as S8: `NoirContractError` with `errorName`, `code`, `contract`, `method`, message `deviceRegistry.register failed: AlreadyRegistered (#4)`.

### Recommendation (PRD fallback)

On-chain uniqueness holds, so a duplicate invoice (same canonical waybill hash) cannot be double-registered or hijacked by another owner. Still keep the DB unique constraint on `invoice_hash` (issue #5 item 4): it gives a friendly error before any network call and avoids a wasted simulation. In the agent, map `AlreadyRegistered` to "invoice already financed". Never reuse a `deviceHash` after `unlinkDevice` without re-testing (not tested here).

## S8: Over-cap authorize: SDK simulation vs on-chain revert (issue #4)

Script: `scripts/spikes/s8.ts` (`npx tsx scripts/spikes/s8.ts`). Policy cap 880 XLM, escrow 2000 XLM funded by LP, payment 1000 XLM.

Device tx (run): registerDevice [9dbfca7c...](https://stellar.expert/explorer/testnet/tx/9dbfca7c57656b76746c9d5e3eb4fb67d24b7d83229a82138946bf77cea98872), registerAgent [7a6b76f1...](https://stellar.expert/explorer/testnet/tx/7a6b76f1fd7ed38201cc13b3652e298c01e4f278977b335a2f762b5ac56930f3), fundEscrow [105c32db...](https://stellar.expert/explorer/testnet/tx/105c32db0c9f6e3f706ba303a97e3ed756a6fa244cb29146f0e8481cb49dcc37).

### `checkPayment` (read-only, no fee, no tx)

| Input | Result |
| --- | --- |
| 1000 XLM (cap 880) | `{ ok: false, reason: 'over_limit' }` |
| 1000 XLM, `requireEscrow: true` | `{ ok: false, reason: 'over_limit' }` (policy checked before escrow) |
| 880 XLM (exact cap), `requireEscrow: true` | `{ ok: true }` (cap is inclusive) |
| 0 XLM | `invalid_amount` |
| other agent | `wrong_agent` |
| other asset | `wrong_asset` |

So `over_limit` is returned **before any fee is paid**. Confirmed.

### `authorizePayment` direct over-cap

**The SDK simulation stops it; nothing is submitted.** `authorizePayment` throws before submission:

```
NoirContractError: paymentEscrow.authorize failed: AgentNotAuthorized (#3)
  name: 'NoirContractError', errorName: 'AgentNotAuthorized', code: 3,
  contract: 'paymentEscrow', method: 'authorize'   (instanceof Error: true)
```

- Agent account sequence was unchanged afterwards (no tx, no fee).
- **The name is `AgentNotAuthorized`, not an over-limit-specific code.** The contract's `authorize` re-runs `check_payment` and collapses every refusal into `AgentNotAuthorized`. The UI must NOT derive the reason from the exception. Use `checkPayment` first for the reason (`over_limit`) and show the SDK error as the second proof line.
- No tx hash exists for a simulation refusal and the message contains none.

### Failed tx hash via SDK: not obtainable

`execute` never submits a tx that fails simulation. A hash appears only in the race path: `Error('... failed on-chain (<hash>)')` (plain `Error`, not `NoirContractError`).

### Forcing an on-chain revert (for a demo that needs an explorer link)

Simulate a valid 10 XLM `authorize`, swap the `amount` i128 arg to 1000 XLM in the built tx, sign and `sendTransaction` without re-simulating (script does this via `client.prepare` + raw XDR edit). Result: accepted (`PENDING`), then `getTransaction` status `FAILED` on-chain, fee charged to the agent: [475ee30d...](https://stellar.expert/explorer/testnet/tx/475ee30d58ec056c36bcd983ae06f8a02f5cd80cba90e0d44512ec3c90f816c8). This works but is a hack and costs a (tiny) fee; use only if judges must see an on-chain revert link.

### UI error format (guardrail demo, PRD §3.4, §13)

Show two lines:
1. `checkPayment` -> `{ ok: false, reason: 'over_limit' }` (the real reason, no fee).
2. SDK error: `NoirContractError: paymentEscrow.authorize failed: AgentNotAuthorized (#3)` using fields `errorName`, `code`, `contract`, `method`.

Optionally add the forced-revert Stellar Expert link above as "on-chain proof".

### Recommendation (PRD fallback)

Primary design works: refuse with `checkPayment` before any fee, and if forced, the SDK refuses at simulation. Gas-free refusal is the story. Treat the forced on-chain failure as an optional P2 extra, not a dependency.
