/**
 * ENV-01: Provision Stellar Testnet demo wallets.
 *
 * Generates TREASURY, SHIPOWNER, LP, DEBTOR, AGENT, RELAYER keypairs,
 * funds them through Friendbot, verifies balances on Horizon, and writes
 * <ROLE>_PUBLIC / <ROLE>_SECRET to .env.local.
 *
 * Idempotent: existing keys in .env.local are reused and never overwritten.
 * Secrets are never printed.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const EXPLORER = "https://stellar.expert/explorer/testnet/account";
const MIN_XLM = 10_000;
const MAX_ATTEMPTS = 6;

const ROLES = ["TREASURY", "SHIPOWNER", "LP", "DEBTOR", "AGENT", "RELAYER"] as const;
type Role = (typeof ROLES)[number];
const MUST_HAVE_MIN: ReadonlySet<Role> = new Set(["AGENT", "SHIPOWNER", "LP", "TREASURY"]);

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out.set(m[1], m[2].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return out;
}

/** Native XLM balance, or null if the account does not exist. */
async function getBalance(pub: string): Promise<number | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${HORIZON}/accounts/${pub}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Horizon HTTP ${res.status}`);
      const body = (await res.json()) as { balances: { asset_type: string; balance: string }[] };
      const native = body.balances.find((b) => b.asset_type === "native");
      return native ? Number(native.balance) : 0;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  return null;
}

async function friendbot(pub: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pub)}`);
      if (res.ok) return;
      const text = await res.text();
      // Already funded is fine.
      if (res.status === 400 && /already funded|createAccountAlreadyExist/i.test(text)) return;
      throw new Error(`Friendbot HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`Friendbot failed for ${pub}: ${(lastErr as Error).message}`);
}

async function main() {
  const existingText = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const env = parseEnv(existingText);
  const additions: string[] = [];
  const keys = {} as Record<Role, Keypair>;

  for (const role of ROLES) {
    const secret = env.get(`${role}_SECRET`);
    const pub = env.get(`${role}_PUBLIC`);
    if (secret) {
      const kp = Keypair.fromSecret(secret); // throws on invalid secret; never overwrite silently
      if (pub && pub !== kp.publicKey()) {
        throw new Error(`${role}_PUBLIC in .env.local does not match ${role}_SECRET. Resolve manually.`);
      }
      keys[role] = kp;
      if (!pub) additions.push(`${role}_PUBLIC=${kp.publicKey()}`);
      console.log(`${role}: reusing existing key`);
    } else {
      if (pub) {
        throw new Error(`${role}_PUBLIC is set without ${role}_SECRET in .env.local. Resolve manually.`);
      }
      const kp = Keypair.random();
      keys[role] = kp;
      additions.push(`${role}_PUBLIC=${kp.publicKey()}`, `${role}_SECRET=${kp.secret()}`);
      console.log(`${role}: generated new key`);
    }
  }

  // Persist keys BEFORE funding so a funding failure never loses generated secrets.
  if (additions.length > 0) {
    const sep = existingText.length === 0 || existingText.endsWith("\n") ? "" : "\n";
    writeFileSync(ENV_PATH, existingText + sep + additions.join("\n") + "\n", { mode: 0o600 });
    console.log(`Wrote ${additions.length} variable(s) to .env.local`);
  }

  const failures: string[] = [];
  for (const role of ROLES) {
    const pub = keys[role].publicKey();
    let bal = await getBalance(pub);
    if (bal === null || bal < (MUST_HAVE_MIN.has(role) ? MIN_XLM : 1)) {
      console.log(`${role}: ${bal === null ? "missing" : "underfunded"}, calling Friendbot`);
      await friendbot(pub);
      for (let i = 0; i < 5; i++) {
        bal = await getBalance(pub);
        if (bal !== null && bal > 0) break;
        await sleep(1500);
      }
    }
    if (bal === null) {
      failures.push(`${role}: account not found after funding`);
    } else if (MUST_HAVE_MIN.has(role) && bal < MIN_XLM) {
      failures.push(`${role}: balance ${bal} XLM < ${MIN_XLM} XLM`);
    }
    console.log(`${role.padEnd(10)} ${bal === null ? "n/a" : bal.toFixed(2).padStart(12)} XLM  ${EXPLORER}/${pub}`);
  }

  if (failures.length) {
    console.error("\nProvisioning problems:\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log("\nAll accounts provisioned and verified.");
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err).replace(/S[A-Z2-7]{55}/g, "[redacted]"));
  process.exit(1);
});
