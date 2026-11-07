/**
 * Loads env from the repo root `.env.local` (made by `npm run provision`) or `apps/server/.env`,
 * if present. On a host (Render, Railway) the variables come from the dashboard instead.
 * Secrets are never logged.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

export const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(SERVER_DIR, "..", "..");
export const WEB_DIR = resolve(REPO_ROOT, "apps", "web");

for (const p of [resolve(REPO_ROOT, ".env.local"), resolve(SERVER_DIR, ".env")]) {
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      /* ignore malformed file; missing keys are reported by checkConfig */
    }
  }
}

export const ROLE_KEYS = ["TREASURY", "SHIPOWNER", "LP", "AGENT"] as const;
export type WalletRole = (typeof ROLE_KEYS)[number];

/**
 * Reads a variable, forgiving common dashboard paste mistakes: surrounding spaces or quotes,
 * and a pasted `NAME=` prefix in front of the value.
 */
export function env(name: string): string | undefined {
  let v = (process.env[name] ?? "").trim();
  if (v.startsWith(`${name}=`)) v = v.slice(name.length + 1).trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1).trim();
  return v || undefined;
}

/**
 * Problems with the wallet variables needed for on-chain calls (empty = ready).
 * Checks that each key is a valid Stellar key and that each _PUBLIC matches its _SECRET,
 * so a bad paste is reported by name instead of failing mid-step with "invalid encoded string".
 */
export function missingChainEnv(): string[] {
  const out: string[] = [];
  for (const r of ROLE_KEYS) {
    const pub = env(`${r}_PUBLIC`);
    const sec = env(`${r}_SECRET`);
    if (!pub) out.push(`${r}_PUBLIC`);
    else if (!StrKey.isValidEd25519PublicKey(pub)) out.push(`${r}_PUBLIC is not a valid Stellar address`);
    if (!sec) out.push(`${r}_SECRET`);
    else if (!StrKey.isValidEd25519SecretSeed(sec)) out.push(`${r}_SECRET is not a valid Stellar secret key`);
    else if (pub && StrKey.isValidEd25519PublicKey(pub) && Keypair.fromSecret(sec).publicKey() !== pub) out.push(`${r}_PUBLIC does not match ${r}_SECRET`);
  }
  return out;
}

export const PORT = Number(env("PORT") ?? 3000);
