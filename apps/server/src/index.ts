/**
 * apps/server: API, Velo webhook receiver, agent runtime and static host for apps/web.
 * Node built-ins only (no framework), run with tsx. One long-running process holds the demo state,
 * so deploy it on a host that keeps a process alive (Render, Railway, Fly), not serverless.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { PORT, WEB_DIR } from "./env.js";
import * as demo from "./demo.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = toJson(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
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

/** Actions run in the background; the UI follows progress over the event stream. */
const ACTIONS: Record<string, () => Promise<unknown>> = {
  "/api/tokenize": demo.tokenize,
  "/api/fund": demo.fund,
  "/api/depart": demo.depart,
  "/api/fast-forward": demo.fastForwardVoyage,
  "/api/checkout": demo.checkout,
  "/api/simulate-webhook": demo.simulateWebhook,
  "/api/guardrail": demo.guardrail,
  "/api/default": demo.simulateDefault,
  "/api/reset": demo.reset,
  "/api/run-demo": demo.runDemo,
};

async function handleAction(path: string, res: ServerResponse): Promise<void> {
  const fn = ACTIONS[path]!;
  const s = demo.getState();
  if (s.busy && path !== "/api/fast-forward") return send(res, 409, { ok: false, error: `Busy: ${s.busy}` });
  const p = fn();
  // Wait briefly so quick validation errors come back in the response; long chain work continues.
  const outcome = await Promise.race([
    p.then(() => ({ done: true as const, error: null })).catch((e: unknown) => ({ done: true as const, error: e instanceof Error ? e.message : String(e) })),
    new Promise<{ done: false; error: null }>((r) => setTimeout(() => r({ done: false, error: null }), 400)),
  ]);
  p.catch(() => undefined); // errors are already recorded in state
  if (outcome.error) return send(res, 400, { ok: false, error: outcome.error });
  send(res, 202, { ok: true, started: !outcome.done });
}

function stream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let pending = false;
  const push = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      res.write(`data: ${toJson(demo.getState())}\n\n`);
    }, 120); // coalesce bursts of updates
  };
  res.write(`data: ${toJson(demo.getState())}\n\n`);
  const off = demo.subscribe(push);
  const hb = setInterval(() => res.write(": hb\n\n"), 15000);
  req.on("close", () => {
    off();
    clearInterval(hb);
  });
}

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const rel = path === "/" ? "/index.html" : path;
  const file = resolve(WEB_DIR, "." + normalize(rel));
  if (!file.startsWith(WEB_DIR)) return send(res, 403, { error: "forbidden" });
  try {
    const st = await stat(file);
    const target = st.isDirectory() ? join(file, "index.html") : file;
    const body = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    if (extname(rel)) return send(res, 404, { error: "not found" }); // missing asset, e.g. optional hero photo
    const body = await readFile(join(WEB_DIR, "index.html"));
    res.writeHead(200, { "content-type": MIME[".html"]! });
    res.end(body);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/api/health") return send(res, 200, { ok: true, status: demo.getState().status, at: new Date().toISOString() });
    if (req.method === "GET" && path === "/api/state") return send(res, 200, demo.getState());
    if (req.method === "GET" && path === "/api/stream") return stream(req, res);
    if (req.method === "POST" && path === "/api/webhooks/velo") {
      const raw = await readBody(req);
      const sig = req.headers["x-velo-signature"];
      const dlv = req.headers["x-velo-delivery"];
      const r = await demo.receiveWebhook(raw, typeof sig === "string" ? sig : null, typeof dlv === "string" ? dlv : null);
      return send(res, r.status, r.body);
    }
    if (req.method === "POST" && path in ACTIONS) return handleAction(path, res);
    if (path.startsWith("/api/")) return send(res, 404, { ok: false, error: "not found" });
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(path, res);
    send(res, 405, { ok: false, error: "method not allowed" });
  } catch (e) {
    send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

demo
  .init()
  .catch((e) => console.error("init:", e instanceof Error ? e.message : e))
  .finally(() => {
    server.listen(PORT, () => console.log(`noirxvelo server on http://localhost:${PORT}`));
  });
