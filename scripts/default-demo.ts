/**
 * EXT-01: Default scenario demo on Stellar Testnet via the @noirxvelo/agent wrapper only.
 * Run: npm run default-demo   (needs .env.local; never prints secrets)
 */
import { createHash, randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NoirAgentClient, keypairSigner, defaultRecovery } from "../packages/agent/src/index.js";
import { toStroops, fromStroops } from "@noirxvelo/shared";

process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"));
const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k} in .env.local`);
  return v;
};

async function main() {
  const client = new NoirAgentClient();
  const treasury = keypairSigner(env("TREASURY_SECRET"));
  const lp = keypairSigner(env("LP_SECRET"));
  const agent = keypairSigner(env("AGENT_SECRET"));
  const deviceHash = createHash("sha256").update("default-demo" + randomBytes(16).toString("hex")).digest("hex");
  const amount = toStroops("850");
  console.log(`deviceHash ${deviceHash}`);

  const a = await client.registerDevice(treasury, deviceHash, env("AGENT_PUBLIC"));
  console.log(`OK registerDevice ${a.explorerUrl}`);
  const b = await client.registerAgent(treasury, deviceHash, env("AGENT_PUBLIC"), toStroops("880"));
  console.log(`OK registerAgent (cap 880 XLM) ${b.explorerUrl}`);
  const c = await client.fundEscrow(lp, deviceHash, amount);
  console.log(`OK fundEscrow (LP 850 XLM) ${c.explorerUrl}`);

  console.log("DEFAULT: due date + grace passed, no payment. Ops triggers recovery.");
  const r = await defaultRecovery({ client, ownerSigner: treasury, deviceHash, agent });
  r.txs.forEach((t, i) => console.log(`OK recovery tx ${i + 1} ${t.explorerUrl}`));
  console.log(`escrow before ${fromStroops(r.escrowBefore)} after ${fromStroops(r.escrowAfter)} returned ${fromStroops(r.escrowReturned)}`);
  console.log(`Treasury XLM before ${fromStroops(r.treasuryBefore)} after ${fromStroops(r.treasuryAfter)} delta ${fromStroops(r.treasuryAfter - r.treasuryBefore)}`);
  console.log(`revoked agent: checkPayment -> ${r.checkAfterRevoke}, authorizePayment refused -> ${r.authorizeRefused} (nothing sent)`);
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});
