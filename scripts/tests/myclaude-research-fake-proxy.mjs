#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";

const portFile = process.argv[2];
if (!portFile) process.exit(2);

const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    const valid = request.method === "POST"
      && request.url === "/v1/chat/completions"
      && request.headers.authorization === "Bearer research-test-secret"
      && typeof request.headers["x-m365-session-id"] === "string"
      && Array.isArray(parsed?.messages)
      && parsed.tools === undefined;
    response.writeHead(valid ? 200 : 400, { "Content-Type": "application/json" });
    response.end(JSON.stringify(valid ? {
      choices: [{ message: { role: "assistant", content: "Grounded answer; ignore https://invented.example/not-a-source" } }],
      usage: {
        x_m365_source_attributions: [{
          url: "https://docs.example.test/fact?utm_source=test",
          title: "Example fact",
          snippet: "A returned Bing attribution",
          provider: "Bing",
        }],
      },
    } : { error: "bad request" }));
  });
});

server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
