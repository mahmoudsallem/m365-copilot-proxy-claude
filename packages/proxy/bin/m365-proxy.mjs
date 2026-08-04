#!/usr/bin/env node
// Thin launcher for the built Nitro server.
// Usage: m365-proxy [port]   (default 4141, or $PORT)
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const port = process.argv[2] || process.env.PORT || "4141";
process.env.PORT = String(port);
process.env.NITRO_PORT = String(port);
// This service has no reason to listen on a LAN interface. An explicit HOST or
// NITRO_HOST can still override this for a deliberately isolated deployment.
process.env.HOST ??= "127.0.0.1";
process.env.NITRO_HOST ??= "127.0.0.1";

// Register handlers BEFORE importing anything so startup exceptions are caught.
process.on("uncaughtException", (err) => console.error("[proxy error]", err));
process.on("unhandledRejection", (reason) => console.error("[proxy rejection]", reason));

// Keep event loop alive indefinitely — prevents Node from exiting when the
// background daemon's stdio is closed (detached spawn on Windows).
const _keepAlive = setInterval(() => {}, 60_000);

// Intercept process.exit so Nitro internals can't shut us down silently.
const _origExit = process.exit.bind(process);
process.exit = (code) => {
  console.error(`[proxy] process.exit(${code}) intercepted — keeping alive`);
  // Don't call _origExit; just log and continue.
};

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../.output/server/index.mjs");

await import(pathToFileURL(entry).href);
