/**
 * Loads env from the repo root `.env.local` (made by `npm run provision`) or `apps/server/.env`,
 * if present. On a host (Render, Railway) the variables come from the dashboard instead.
 * Secrets are never logged.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/** Names of missing variables needed for on-chain calls (empty = ready). */
export function missingChainEnv(): string[] {
  const out: string[] = [];
  for (const r of ROLE_KEYS) {
    if (!env(`${r}_PUBLIC`)) out.push(`${r}_PUBLIC`);
    if (!env(`${r}_SECRET`)) out.push(`${r}_SECRET`);
  }
  return out;
}

export const PORT = Number(env("PORT") ?? 3000);
