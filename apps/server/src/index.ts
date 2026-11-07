/**
 * apps/server: API, Velo webhook receiver, agent runtime and static host for apps/web.
 * Node built-ins only (no framework), run with tsx. One long-running process holds the demo state,
 * so a host that keeps a process alive (Render, Railway, Fly) gives the best demo.
 * On Vercel the same handler runs as a function instead (see vercel.ts and scripts/build-vercel.ts).
 */
import { createServer } from "node:http";
import { handler, ready } from "./app.js";
import { PORT } from "./env.js";

const server = createServer(handler);

ready.finally(() => {
  server.listen(PORT, () => console.log(`noirxvelo server on http://localhost:${PORT}`));
});
