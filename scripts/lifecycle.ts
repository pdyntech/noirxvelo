/**
 * CHN-02: full Noir lifecycle on Stellar Testnet via the @noirxvelo/agent wrapper only.
 * Run: npx tsx scripts/lifecycle.ts   (needs .env.local; never prints secrets)
 */
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { NoirAgentClient, keypairSigner, type TxResult } from "../packages/agent/src/index.js";
import { toStroops, fromStroops } from "@noirxvelo/shared";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(resolve(root, ".env.local"));

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k} in .env.local`);
  return v;
};
const pub = (r: string) => env(`${r}_PUBLIC`);
const signer = (r: string) => keypairSigner(env(`${r}_SECRET`));

const HORIZON = "https://horizon-testnet.stellar.org";

export const makeDeviceHash = (salt: string = randomBytes(16).toString("hex")): string =>
  createHash("sha256").update("test-waybill" + salt).digest("hex");

async function xlmBalance(account: string): Promise<bigint> {
  const res = await fetch(`${HORIZON}/accounts/${account}`);
  if (!res.ok) throw new Error(`horizon ${res.status} for ${account}`);
  const j = (await res.json()) as { balances: { asset_type: string; balance: string }[] };
  const n = j.balances.find((b) => b.asset_type === "native");
  if (!n) throw new Error("no native balance");
  return toStroops(n.balance);
}

const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const steps: { label: string; tx: TxResult }[] = [];
const ok = (label: string, tx: TxResult) => {
  steps.push({ label, tx });
  console.log(`OK ${label} ${tx.explorerUrl}`);
};

async function main() {
  const client = new NoirAgentClient();
  const treasury = signer("TREASURY");
  const lp = signer("LP");
  const agent = signer("AGENT");
  const shipowner = signer("SHIPOWNER");
  const shipPub = pub("SHIPOWNER");
  const agentPub = pub("AGENT");

  const deviceHash = makeDeviceHash();
  const cap = toStroops("880");
  const amount = toStroops("850");
  console.log(`deviceHash ${deviceHash}`);

  ok("1 registerDevice", await client.registerDevice(treasury, deviceHash, agentPub));
  ok("2 registerAgent (cap 880 XLM)", await client.registerAgent(treasury, deviceHash, agentPub, cap));
  ok("3 fundEscrow (LP 850 XLM)", await client.fundEscrow(lp, deviceHash, amount));

  assert((await client.balanceOf(deviceHash)) === amount, "escrow == 850 XLM after fund");
  const check = await client.checkPayment({ deviceHash, agent: agentPub, amount, requireEscrow: true });
  assert(check.ok === true, `checkPayment ok (got ${show(check)})`);
  console.log("OK 4 checkPayment {ok:true} (read-only, no tx)");

  const auth = await client.authorizePayment({ agentSigner: agent, deviceHash, merchant: shipPub, amount });
  assert(auth.ok === true, `authorizePayment (got ${show(auth)})`);
  if (!auth.ok) throw new Error("unreachable");
  ok("5 authorizePayment (850 XLM -> SHIPOWNER)", auth);
  assert((await client.pendingBalance(shipPub)) === amount, "pending == 850 XLM before claim");

  const before = await xlmBalance(shipPub);
  ok("6 claim (SHIPOWNER)", await client.claim(shipowner));
  const after = await xlmBalance(shipPub);

  const escrow = await client.balanceOf(deviceHash);
  const pending = await client.pendingBalance(shipPub);
  assert(escrow === 0n, `escrow == 0 (got ${escrow})`);
  assert(pending === 0n, `pending == 0 (got ${pending})`);
  const delta = after - before;
  assert(delta > amount - toStroops("1") && delta < amount, "delta ~ +850 XLM minus fee");

  console.log(`SHIPOWNER XLM before ${fromStroops(before)} after ${fromStroops(after)} delta ${fromStroops(delta)}`);
  console.log(`escrow ${escrow} pending ${pending}`);

  const links = steps.map((s, i) => `${i + 1}. ${s.label}: [${s.tx.hash.slice(0, 8)}...](${s.tx.explorerUrl})`);
  const doc = `# Testnet proof

Date: ${new Date().toISOString()}

Full Noir lifecycle on Stellar Testnet, run by \`npx tsx scripts/lifecycle.ts\` through the \`@noirxvelo/agent\` wrapper.

Device hash: \`${deviceHash}\`

## Transactions

${links.join("\n")}

Step 4 (\`checkPayment\` with \`requireEscrow: true\`) is a read-only simulation returning \`{ ok: true }\`; it has no transaction.

## Balances (SHIPOWNER, native XLM, from Horizon)

| | XLM |
| --- | --- |
| Before claim | ${fromStroops(before)} |
| After claim | ${fromStroops(after)} |
| Delta | +${fromStroops(delta)} (850 minus claim fee) |

After claim: device escrow balance \`${escrow}\`, SHIPOWNER pending balance \`${pending}\`.
`;
  writeFileSync(resolve(root, "docs", "testnet-proof.md"), doc);
  console.log("wrote docs/testnet-proof.md");
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});
