/**
 * Tiny JSON-file store for the website: accounts, sessions, enquiries, subscribers and portal invoices.
 * Kept in DATA_DIR (default apps/server/data, git-ignored). Writes are debounced and atomic (tmp + rename).
 * One process owns the file; this is sized for a demo, not for production traffic.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SERVER_DIR, env } from "./env.js";
import type { PortalInvoice } from "./portal.js";

export type AccountRole = "Shipowner" | "Investor" | "Cargo owner";
export const ACCOUNT_ROLES: AccountRole[] = ["Shipowner", "Investor", "Cargo owner"];

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

export const db: Data = load();

let timer: NodeJS.Timeout | null = null;

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
  if (!timer) timer = setTimeout(flush, 200);
}

/** Write immediately (used on shutdown). */
export function saveNow(): void {
  if (timer) clearTimeout(timer);
  flush();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    saveNow();
    process.exit(0);
  });
}
