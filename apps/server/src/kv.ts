/**
 * Shared key-value store (Redis), so every server instance sees the same accounts, invoices and demo run.
 * On Vercel each request can land on a different instance and instances are recycled, so memory alone loses data.
 *
 * Configure ONE of:
 *   KV_REST_API_URL + KV_REST_API_TOKEN            (Upstash via the Vercel Marketplace)
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *   REDIS_URL or KV_URL                            (any Redis, redis:// or rediss://)
 * With none set, kvEnabled() is false and callers fall back to memory / a local file (fine for `npm start`).
 */
import { randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { env } from "./env.js";

type Reply = string | number | null | Reply[];
type Backend = (args: string[]) => Promise<Reply>;

const TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`kv: ${what} timed out`)), TIMEOUT_MS);
    p.then(
      (v) => (clearTimeout(t), ok(v)),
      (e) => (clearTimeout(t), fail(e)),
    );
  });
}

function restBackend(url: string, token: string): Backend {
  const base = url.replace(/\/+$/, "");
  return async (args) => {
    const res = await withTimeout(
      fetch(base, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) }),
      args[0]!,
    );
    const j = (await res.json().catch(() => ({}))) as { result?: Reply; error?: string };
    if (!res.ok || j.error) throw new Error(`kv: ${args[0]} failed: ${j.error ?? res.status}`);
    return j.result ?? null;
  };
}

function tcpBackend(url: string): Backend {
  type Client = { connect(): Promise<unknown>; sendCommand(a: string[]): Promise<unknown>; destroy?(): void; on(e: string, f: (x: unknown) => void): void };
  let client: Promise<Client> | null = null;
  const connect = (): Promise<Client> =>
    (client ??= (async () => {
      const { createClient } = await import("redis");
      const c = createClient({ url, socket: { connectTimeout: 5000, reconnectStrategy: (n: number) => Math.min(n * 200, 2000) } }) as unknown as Client;
      c.on("error", () => undefined); // reconnects on its own; a command error is reported to the caller
      await c.connect();
      return c;
    })().catch((e) => {
      client = null;
      throw e;
    }));
  return async (args) => {
    const c = await withTimeout(connect(), "connect");
    try {
      return (await withTimeout(c.sendCommand(args), args[0]!)) as Reply;
    } catch (e) {
      // A frozen serverless instance can wake up with a dead socket: start over next time.
      if (e instanceof Error && /timed out|closed|ECONNRESET|EPIPE/i.test(e.message)) {
        try {
          c.destroy?.();
        } catch {
          /* ignore */
        }
        client = null;
      }
      throw e;
    }
  };
}

let backend: Backend | null | undefined;
let backendName = "none";
function getBackend(): Backend | null {
  if (backend !== undefined) return backend;
  const restUrl = env("KV_REST_API_URL") ?? env("UPSTASH_REDIS_REST_URL");
  const restToken = env("KV_REST_API_TOKEN") ?? env("UPSTASH_REDIS_REST_TOKEN");
  const tcpUrl = env("REDIS_URL") ?? env("KV_URL");
  if (restUrl && restToken) {
    backend = restBackend(restUrl, restToken);
    backendName = "redis-rest";
  } else if (tcpUrl) {
    backend = tcpBackend(tcpUrl);
    backendName = "redis";
  } else backend = null;
  return backend;
}

export const kvEnabled = (): boolean => getBackend() !== null;
export const kvBackend = (): string => (getBackend(), backendName);

/** Key prefix, so several deployments can share one database without clashing. */
const PREFIX = (env("KV_PREFIX") ?? "sailo") + ":";
export const key = (k: string): string => PREFIX + k;

export async function cmd(...args: (string | number)[]): Promise<Reply> {
  const b = getBackend();
  if (!b) throw new Error("kv: no store configured");
  return b(args.map(String));
}

export async function getJson<T>(k: string): Promise<T | null> {
  const v = await cmd("GET", key(k));
  if (typeof v !== "string") return null;
  // Values are gzip + base64 so a growing account list stays well under the store's value size limit.
  const text = v.startsWith("{") || v.startsWith("[") ? v : gunzipSync(Buffer.from(v, "base64")).toString("utf8");
  return JSON.parse(text) as T;
}

export async function setJson(k: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  await cmd("SET", key(k), gzipSync(text).toString("base64"));
}

/** Set only if absent. Returns true when this call created the key. */
export async function setNx(k: string, value: string, ttlMs: number): Promise<boolean> {
  return (await cmd("SET", key(k), value, "NX", "PX", ttlMs)) === "OK";
}

const RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const EXTEND = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";

/** Delete only if it still holds `value` (so an expired lock re-taken by someone else is left alone). */
export async function delIf(k: string, value: string): Promise<boolean> {
  return Number(await cmd("EVAL", RELEASE, 1, key(k), value)) === 1;
}
export async function extendIf(k: string, value: string, ttlMs: number): Promise<boolean> {
  return Number(await cmd("EVAL", EXTEND, 1, key(k), value, ttlMs)) === 1;
}
export async function getRaw(k: string): Promise<string | null> {
  const v = await cmd("GET", key(k));
  return typeof v === "string" ? v : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-process locks, used when no store is configured (one process, so this is enough). */
const local = new Map<string, Promise<unknown>>();
async function localLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = local.get(name) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = prev.then(() => mine);
  local.set(name, chain);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (local.get(name) === chain) local.delete(name);
  }
}

export class LockTimeout extends Error {}

/**
 * Runs fn while holding a named lock shared by every instance.
 * ttlMs bounds how long a crashed holder can block others; long work keeps extending it.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>, o: { ttlMs?: number; waitMs?: number } = {}): Promise<T> {
  if (!kvEnabled()) return localLock(name, fn);
  const ttl = o.ttlMs ?? 20_000;
  const deadline = Date.now() + (o.waitMs ?? 15_000);
  const token = randomBytes(12).toString("hex");
  const k = `lock:${name}`;
  let delay = 20;
  // Same-instance callers queue locally first, so they don't spin against the store.
  return localLock(name, async () => {
    while (!(await setNx(k, token, ttl))) {
      if (Date.now() > deadline) throw new LockTimeout(`Busy, please try again (${name}).`);
      await sleep(delay + Math.floor(Math.random() * delay));
      delay = Math.min(delay * 2, 400);
    }
    const keep = setInterval(() => void extendIf(k, token, ttl).catch(() => undefined), Math.max(1000, Math.floor(ttl / 3)));
    try {
      return await fn();
    } finally {
      clearInterval(keep);
      await delIf(k, token).catch(() => undefined);
    }
  });
}

/** Id of this server instance (for leases and logs). */
export const INSTANCE_ID = randomBytes(6).toString("hex");
