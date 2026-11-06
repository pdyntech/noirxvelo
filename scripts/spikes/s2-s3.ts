/**
 * Spikes S2 + S3 (issue #5), live on Stellar Testnet.
 * S2: can a non-owner (LP) fundEscrow a Treasury-owned device? Plus happy path and claim semantics.
 * S3: is a duplicate registerDevice (same hash) rejected, by same owner and by another owner?
 * Run: npx tsx scripts/spikes/s2-s3.ts
 */
import { client, XLM, pub, signer, freshHash, toStroops, step, log } from "./_common.ts";

const treasury = signer("TREASURY");
const lp = signer("LP");
const agent = signer("AGENT");
const shipowner = signer("SHIPOWNER");
const deviceHash = freshHash();
log("deviceHash", deviceHash);

log("\n== setup ==");
await step("treasury registerDevice", () =>
  client.execute(treasury, { kind: "registerDevice", deviceHash, agent: pub("AGENT") }));
await step("treasury registerAgent cap=880 XLM", () =>
  client.execute(treasury, {
    kind: "registerAgent", deviceHash, agent: pub("AGENT"), asset: XLM, maxAmount: toStroops("880"),
  }));
log("owner", await client.getDeviceOwner(deviceHash), "(treasury", pub("TREASURY") + ")");

log("\n== S2: LP (non-owner) fundEscrow ==");
const lpFund = await step("LP fundEscrow 100 XLM", () =>
  client.execute(lp, { kind: "fundEscrow", deviceHash, token: XLM, amount: toStroops("100") }));
log("escrow balance after LP fund (stroops)", await client.getEscrowBalance(deviceHash));
log("escrow token", await client.getEscrowToken(deviceHash), "(XLM SAC", XLM + ")");

if (!lpFund.ok) {
  await step("treasury fundEscrow 100 XLM (fallback)", () =>
    client.execute(treasury, { kind: "fundEscrow", deviceHash, token: XLM, amount: toStroops("100") }));
  log("escrow balance after treasury fund", await client.getEscrowBalance(deviceHash));
}

log("\n== S2 extra: token binding (fund with a different token) ==");
const fakeToken = "CC7EAW5FNJEDBS7THM5IT6XIOHO4AOYMLXT3KSZ3HWUIKEACTW7E5BFS"; // paymentEscrow contract id: valid C-address, not a token, differs from bound XLM SAC
await step("LP fundEscrow with different token", () =>
  client.execute(lp, { kind: "fundEscrow", deviceHash, token: fakeToken, amount: toStroops("1") }));
log("escrow balance after wrong-token attempt", await client.getEscrowBalance(deviceHash));

log("\n== happy path ==");
log("checkPayment 10 XLM", JSON.stringify(await client.checkPayment({
  deviceHash, agent: pub("AGENT"), asset: XLM, amount: toStroops("10"), requireEscrow: true })));
// second device for the same merchant, to test that one claim pays across devices
const deviceB = freshHash();
await step("treasury registerDevice B", () =>
  client.execute(treasury, { kind: "registerDevice", deviceHash: deviceB, agent: pub("AGENT") }));
await step("treasury registerAgent B", () =>
  client.execute(treasury, { kind: "registerAgent", deviceHash: deviceB, agent: pub("AGENT"), asset: XLM, maxAmount: toStroops("880") }));
await step("LP fundEscrow B 20 XLM", () =>
  client.execute(lp, { kind: "fundEscrow", deviceHash: deviceB, token: XLM, amount: toStroops("20") }));
await step("agent authorizePayment B 5 XLM -> shipowner", () =>
  client.authorizePayment({ agent, deviceHash: deviceB, merchant: pub("SHIPOWNER"), asset: XLM, amount: toStroops("5") }));
const pendingBefore = await client.getPendingBalance(pub("SHIPOWNER"));
const auth = await step("agent authorizePayment 10 XLM -> shipowner", () =>
  client.authorizePayment({ agent, deviceHash, merchant: pub("SHIPOWNER"), asset: XLM, amount: toStroops("10") }));
log("pending shipowner before/after", pendingBefore, await client.getPendingBalance(pub("SHIPOWNER")));
log("escrow balance after authorize", await client.getEscrowBalance(deviceHash));
await step("shipowner claim XLM", () => client.claim({ merchant: shipowner, token: XLM }));
log("pending shipowner after claim", await client.getPendingBalance(pub("SHIPOWNER")), "(expect 0: one claim drained both devices' payments)");
void auth;

log("\n== S3: duplicate registerDevice ==");
await step("treasury registerDevice again (same owner, same agent)", () =>
  client.execute(treasury, { kind: "registerDevice", deviceHash, agent: pub("AGENT") }));
await step("LP registerDevice same hash (different owner)", () =>
  client.execute(lp, { kind: "registerDevice", deviceHash, agent: pub("AGENT") }));
log("owner after dup attempts", await client.getDeviceOwner(deviceHash));
await step("treasury registerAgent again (policy overwrite?)", () =>
  client.execute(treasury, {
    kind: "registerAgent", deviceHash, agent: pub("AGENT"), asset: XLM, maxAmount: toStroops("1"),
  }));
log("policy", JSON.stringify(await client.getPolicy(deviceHash), (_, v) => typeof v === "bigint" ? v.toString() : v));

log("\n== cleanup ==");
await step("unlinkDevice (return escrow)", async () => {
  const r = await client.unlinkDevice({ owner: treasury, deviceHash });
  log("hashes", r.hashes.map((h) => `https://stellar.expert/explorer/testnet/tx/${h}`), "returned", r.escrowReturned);
  return { hash: r.hashes.at(-1) };
});
await step("unlinkDevice B", async () => {
  const r = await client.unlinkDevice({ owner: treasury, deviceHash: deviceB });
  log("returned B", r.escrowReturned);
  return { hash: r.hashes.at(-1) };
});
