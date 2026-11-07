/**
 * Store for the website: accounts, sessions, enquiries, subscribers and portal invoices.
 *
 * - With a shared store (kv.ts, e.g. Upstash on Vercel): every API request runs inside withDb(), which takes a
 *   lock, loads the latest copy, runs the handler and writes back only if something changed. Every instance
 *   therefore sees the same data, and nothing is lost when an instance is recycled.
 * - Without one (`npm start`): a JSON file in DATA_DIR (default apps/server/data, git-ignored), debounced and
 *   atomic (tmp + rename), owned by the single process.
 * Sized for a demo, not for production traffic.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SERVER_DIR, env } from "./env.js";
import { getJson, kvEnabled, setJson, withLock } from "./kv.js";
import type { PortalInvoice } from "./portal.js";

export type AccountRole = "Shipowner" | "Investor" | "Cargo owner";
export const ACCOUNT_ROLES: AccountRole[] = ["Shipowner", "Investor", "Cargo owner"];

/** Custodial Stellar Testnet wallet for portal payments. The secret is encrypted (wallets.ts). */
export interface StoredWallet {
  publicKey: string;
  secretEnc: string;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  company: string;
  role: AccountRole;
  salt: string;
  hash: string;
  createdAt: string;
  /** Set when the user follows the link in the verification (or password reset) email. */
  emailVerifiedAt: string | null;
  passwordChangedAt: string;
  wallet?: StoredWallet | null;
}

export interface Session {
  /** sha256 of the cookie token; the raw token is never stored. */
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** Short browser description, so users can tell sessions apart. */
  agent: string;
}

/** One-time link token (email verification or password reset). Only its sha256 is stored. */
export interface AuthToken {
  id: string;
  userId: string;
  kind: "verify" | "reset";
  expiresAt: number;
}

export interface Enquiry {
  at: string;
  name: string;
  company: string;
  role: string;
  email: string;
  msg: string;
}

export interface Data {
  version: 1;
  users: User[];
  sessions: Session[];
  tokens: AuthToken[];
  enquiries: Enquiry[];
  subscribers: { email: string; at: string }[];
  invoices: PortalInvoice[];
  seq: number;
}

export const DATA_DIR = resolve(env("DATA_DIR") ?? resolve(SERVER_DIR, "data"));
const FILE = resolve(DATA_DIR, "sailo.json");

function empty(): Data {
  return { version: 1, users: [], sessions: [], tokens: [], enquiries: [], subscribers: [], invoices: [], seq: 0 };
}

function load(): Data {
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, "utf8")) as Partial<Data>;
      return { ...empty(), ...d, version: 1 };
    }
  } catch (e) {
    console.error("db: could not read", FILE, "-", e instanceof Error ? e.message : e, "(starting empty)");
  }
  return empty();
}

export const db: Data = kvEnabled() ? empty() : load();

let timer: NodeJS.Timeout | null = null;
let dirty = false;

function flush(): void {
  timer = null;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(db));
    renameSync(tmp, FILE);
  } catch (e) {
    console.error("db: write failed:", e instanceof Error ? e.message : e);
  }
}

/** Schedule a save. Call after every mutation. */
export function save(): void {
  dirty = true;
  if (kvEnabled()) return; // written at the end of withDb
  if (!timer) timer = setTimeout(flush, 200);
}

/** Write immediately (used on shutdown). */
export function saveNow(): void {
  if (kvEnabled()) return;
  if (timer) clearTimeout(timer);
  flush();
}

const DB_KEY = "db";
type Hook = () => void;
const beforeHooks: Hook[] = [];
/** Runs at the start of every withDb (after the latest data is loaded), e.g. time-based portal steps. */
export function onDbLoad(fn: Hook): void {
  beforeHooks.push(fn);
}

/**
 * Run fn against the latest data. With a shared store this holds the db lock for the duration,
 * so keep fn short: never await chain transactions inside it.
 */
export async function withDb<T>(fn: () => T | Promise<T>): Promise<T> {
  if (!kvEnabled()) {
    for (const h of beforeHooks) h();
    return fn();
  }
  return withLock(
    DB_KEY,
    async () => {
      const latest = await getJson<Partial<Data>>(DB_KEY);
      Object.assign(db, empty(), latest ?? {}, { version: 1 });
      dirty = false;
      for (const h of beforeHooks) h();
      try {
        return await fn();
      } finally {
        // Persist even when fn threw part-way: mutations before the throw (e.g. a failed-login counter) are intended.
        if (dirty) {
          dirty = false;
          await setJson(DB_KEY, db);
        }
      }
    },
    { ttlMs: 20_000, waitMs: 15_000 },
  );
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    saveNow();
    process.exit(0);
  });
}
