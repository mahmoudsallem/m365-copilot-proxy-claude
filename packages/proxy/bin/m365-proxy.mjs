#!/usr/bin/env node
// Thin launcher for the built Nitro server.
// Usage: m365-proxy [port]   (default 4141, or $PORT)
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const port = process.argv[2] || process.env.PORT || "4141";
process.env.PORT = String(port);
process.env.NITRO_PORT = String(port);
// This service has no reason to listen on a LAN interface. An explicit HOST or
// NITRO_HOST can still override this for a deliberately isolated deployment.
process.env.HOST ??= "127.0.0.1";
process.env.NITRO_HOST ??= "127.0.0.1";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../.output/server/index.mjs");

await import(entry);
