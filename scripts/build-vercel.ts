/**
 * Builds the Vercel deployment with the Build Output API (https://vercel.com/docs/build-output-api):
 *   .vercel/output/static/          apps/web as-is (no frontend build step)
 *   .vercel/output/functions/api.func  the server bundled into one file, handling /api/*
 *   .vercel/output/config.json      routes
 * Run by `npm run build` (vercel.json sets it as the build command).
 */
import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, ".vercel/output");
const fn = resolve(out, "functions/api.func");

await rm(out, { recursive: true, force: true });
await mkdir(fn, { recursive: true });

await cp(resolve(root, "apps/web"), resolve(out, "static"), { recursive: true });

await build({
  entryPoints: [resolve(root, "apps/server/src/vercel.ts")],
  outfile: resolve(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Bundled CommonJS dependencies call require() for Node built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  external: ["sodium-native"], // optional native speedup in stellar-base; it falls back to pure JS
  logLevel: "warning",
});

await writeFile(
  resolve(fn, ".vc-config.json"),
  JSON.stringify({ runtime: "nodejs24.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 300 }, null, 2),
);
await writeFile(resolve(fn, "package.json"), JSON.stringify({ type: "module" }));

await writeFile(
  resolve(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "^/api(?:/.*)?$", dest: "/api" },
        { handle: "filesystem" },
        { src: "^/app/?$", dest: "/app/index.html" },
        // Same fallback as the Node server: unknown page paths get the landing page, missing assets 404.
        { src: "^/[^.]*$", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);

console.log("Vercel build output written to .vercel/output");
