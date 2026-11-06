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
