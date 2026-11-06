/**
 * Spike S8 (issue #4), live on Stellar Testnet.
 * Over-cap payment: checkPayment refusal, authorizePayment simulation vs on-chain revert,
 * error shape for the UI, and whether a failed tx hash is obtainable.
 * Run: npx tsx scripts/spikes/s8.ts
 */
import { Networks, TransactionBuilder, xdr, nativeToScVal, Address } from "@stellar/stellar-sdk";
import { client, XLM, pub, signer, freshHash, toStroops, step, log, txLink } from "./_common.ts";

const treasury = signer("TREASURY");
const lp = signer("LP");
const agent = signer("AGENT");
const deviceHash = freshHash();
log("deviceHash", deviceHash);

await step("treasury registerDevice", () =>
  client.execute(treasury, { kind: "registerDevice", deviceHash, agent: pub("AGENT") }));
await step("treasury registerAgent cap=880 XLM", () =>
  client.execute(treasury, { kind: "registerAgent", deviceHash, agent: pub("AGENT"), asset: XLM, maxAmount: toStroops("880") }));
await step("LP fundEscrow 2000 XLM", () =>
  client.execute(lp, { kind: "fundEscrow", deviceHash, token: XLM, amount: toStroops("2000") }));

const base = { deviceHash, agent: pub("AGENT"), asset: XLM };
const show = async (label: string, p: Parameters<typeof client.checkPayment>[0]) =>
  log(`checkPayment ${label}:`, JSON.stringify(await client.checkPayment(p)));

log("\n== checkPayment (read-only, no fee) ==");
await show("1000 XLM (cap 880, escrow 2000)", { ...base, amount: toStroops("1000") });
await show("1000 XLM requireEscrow", { ...base, amount: toStroops("1000"), requireEscrow: true });
await show("880 XLM exact cap", { ...base, amount: toStroops("880"), requireEscrow: true });
await show("0 XLM", { ...base, amount: 0n });
await show("100 XLM wrong agent", { ...base, agent: pub("RELAYER"), amount: toStroops("100") });
await show("100 XLM wrong asset", { ...base, asset: "CC7EAW5FNJEDBS7THM5IT6XIOHO4AOYMLXT3KSZ3HWUIKEACTW7E5BFS", amount: toStroops("100") });

log("\n== authorizePayment direct over-cap (1000 XLM) ==");
const before = await (await fetch("https://horizon-testnet.stellar.org/accounts/" + pub("AGENT"))).json() as any;
const seqBefore = before.sequence;
const over = await step("authorizePayment 1000 XLM", () =>
  client.authorizePayment({ agent, deviceHash, merchant: pub("SHIPOWNER"), asset: XLM, amount: toStroops("1000") }));
const after = await (await fetch("https://horizon-testnet.stellar.org/accounts/" + pub("AGENT"))).json() as any;
log("agent sequence unchanged (nothing submitted, no fee):", seqBefore === after.sequence);
if (!over.ok) {
  const e = over.raw;
  log("instanceof Error:", e instanceof Error, "| .toString():", String(e));
  log("tx hash in message?", /[0-9a-f]{64}/.test(String(e?.message)));
}

log("\n== force on-chain failure: simulate valid call, swap amount arg, submit without re-simulation ==");
const server = (client as any).server;
const nonce = BigInt(Date.now());
const goodXdr = await client.prepare(pub("AGENT"), {
  kind: "authorize", deviceHash, merchant: pub("SHIPOWNER"), asset: XLM, amount: toStroops("10"), nonce });
const tx = TransactionBuilder.fromXDR(goodXdr, Networks.TESTNET) as any;
const invoke = tx.operations[0].func.invokeContract();
const args = invoke.args();
const idx = args.findIndex((a: any) => a.switch().name === "scvI128");
log("amount arg index", idx, "of", args.length);
args[idx] = nativeToScVal(toStroops("1000"), { type: "i128" });
invoke.args(args);
tx.sign(agent.keypair ?? (await import("@stellar/stellar-sdk")).Keypair.fromSecret(process.env.AGENT_SECRET!));
const sent = await server.sendTransaction(tx);
log("sendTransaction status", sent.status, "hash", sent.hash);
if (sent.status !== "ERROR") {
  for (let i = 0; i < 30; i++) {
    const got = await server.getTransaction(sent.hash);
    if (got.status !== "NOT_FOUND") {
      log("final status", got.status, txLink(sent.hash));
      if (got.status === "FAILED") log("resultXdr present:", !!got.resultXdr);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
} else {
  log("rejected pre-ledger:", sent.errorResult?.result().switch().name);
}

log("\n== cleanup ==");
const r = await client.unlinkDevice({ owner: treasury, deviceHash });
log("unlink", r.hashes.map(txLink), "returned", r.escrowReturned);
