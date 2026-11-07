/** Small HTTP helpers shared by the demo API and the site/portal API. */
import type { IncomingMessage, ServerResponse } from "node:http";

export const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const text = toJson(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(text);
}

export function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

/** Error with an HTTP status, for request validation. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reads a JSON object body. Requires `content-type: application/json`, which a cross-site
 * HTML form cannot send without a CORS preflight, so cookie-authenticated POSTs are CSRF-safe.
 */
export async function readJson(req: IncomingMessage, limit = 20_000): Promise<Record<string, unknown>> {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Send JSON (content-type: application/json).");
  }
  const raw = await readBody(req, limit).catch(() => {
    throw new HttpError(413, "Request too large.");
  });
  if (!raw.trim()) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "Invalid JSON body.");
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

/** True when the request reached us over HTTPS (directly or via a proxy such as Render/Railway). */
export function isHttps(req: IncomingMessage): boolean {
  const xf = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  return xf === "https" || Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

/** Trust X-Forwarded-For only behind a hosting proxy (production, or TRUST_PROXY=1). */
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === "1" : process.env.NODE_ENV === "production";

export function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    // The proxy appends the real client address, so the last entry is the one it vouches for.
    const xf = String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean).pop();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || "unknown";
}
