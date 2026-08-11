#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";

const portFile = process.argv[2];
if (!portFile) process.exit(2);

const server = http.createServer((request, response) => {
  const valid = request.method === "GET"
    && request.url === "/v1/models"
    && request.headers.authorization === "Bearer launcher-test-secret";
  response.writeHead(valid ? 200 : 401, { "Content-Type": "application/json" });
  response.end(JSON.stringify(valid ? { object: "list", data: [] } : { error: "unauthorized" }));
});

server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
