/**
 * Vercel function entry: every /api/* request lands here (see scripts/build-vercel.ts).
 * The static frontend in apps/web is served by Vercel's CDN, not by this function.
 *
 * - Data lives in the shared store (kv.ts) when one is configured: add Upstash (Vercel Marketplace) or any
 *   Redis. Without it, data sits in this instance's memory and /tmp and resets when the instance is recycled.
 * - Work that outlives the response (chain transactions, a voyage) is handed to waitUntil, up to maxDuration.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";

// The repo folder is read-only on Vercel; /tmp is the only writable place. Set before db.ts loads.
process.env.DATA_DIR ??= "/tmp/sailo";

const app = import("./app.js");
const bg = import("./background.js");

export default async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { handler, ready } = await app;
  await ready;
  await handler(req, res);
  const { drain, hasWork } = await bg;
  if (hasWork()) waitUntil(drain(290_000)); // stay inside maxDuration (300 s)
}
