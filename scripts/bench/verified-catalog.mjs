#!/usr/bin/env node

import {
  VERIFIED_CATALOG_VERSION,
  VERIFIED_TASKS,
  validateVerifiedCatalog,
} from "./verified-tasks.mjs";

const command = process.argv[2] ?? "validate";
if (command === "validate") {
  const result = { schema: VERIFIED_CATALOG_VERSION, ...validateVerifiedCatalog() };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
} else if (command === "list") {
  for (const item of VERIFIED_TASKS) {
    process.stdout.write(`${item.id}\t${item.category}\t${item.risk}\t${item.critical ? "critical" : "standard"}\n`);
  }
} else if (command === "json") {
  process.stdout.write(`${JSON.stringify({ schema: VERIFIED_CATALOG_VERSION, tasks: VERIFIED_TASKS }, null, 2)}\n`);
} else {
  process.stderr.write("Usage: verified-catalog.mjs validate|list|json\n");
  process.exitCode = 2;
}
