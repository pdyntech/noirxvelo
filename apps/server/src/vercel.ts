/**
 * Vercel function entry: every /api/* request lands here (see scripts/build-vercel.ts).
 * The static frontend in apps/web is served by Vercel's CDN, not by this function.
 *
 * Limits compared with a long-running host (Render, Railway):
 * - State lives in the function instance's memory and /tmp, so it resets when the instance is recycled
 *   and is not shared between instances. Fine for a demo, not for real accounts.
 * - Background demo steps keep running after the response through waitUntil, up to maxDuration.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";

// The repo folder is read-only on Vercel; /tmp is the only writable place. Set before db.ts loads.
process.env.DATA_DIR ??= "/tmp/sailo";

const app = import("./app.js");
const demo = import("./demo.js");

/** Resolves when the demo is no longer busy, so long chain work isn't frozen mid-step. */
async function untilIdle(): Promise<void> {
  const { getState } = await demo;
  const stopAt = Date.now() + 290_000; // stay inside maxDuration (300 s)
  while (getState().busy && Date.now() < stopAt) await new Promise((r) => setTimeout(r, 500));
}

export default async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { handler, ready } = await app;
  await ready;
  await handler(req, res);
  if (req.method === "POST") waitUntil(untilIdle());
}
