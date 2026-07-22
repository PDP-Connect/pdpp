#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Manual stdio protocol-hygiene smoke. Boots pdpp-mcp-server with a temp cache, sends
// an MCP initialize + tools/list, asserts stdout contains only newline-delimited JSON.
//
// Usage:
//   node packages/mcp-server/test/smoke-stdio.mjs > tmp/workstreams/mcp-stdio-smoke.json
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, "..", "bin", "pdpp-mcp-server.js");

const cacheRoot = await mkdtemp(join(tmpdir(), "pdpp-mcp-smoke-"));

const rs = createServer((req, res) => {
  if (req.url === "/v1/schema") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ streams: ["orders"], version: "1" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: "not_found" } }));
});
await new Promise((resolve) => rs.listen(0, "127.0.0.1", resolve));
const port = rs.address().port;
const providerUrl = `http://127.0.0.1:${port}`;

const host = new URL(providerUrl).host.replace(/[^a-zA-Z0-9.-]/g, "_");
await mkdir(join(cacheRoot, "clients"), { recursive: true });
await writeFile(
  join(cacheRoot, "clients", `${host}.json`),
  JSON.stringify({ credential: { access_token: "smoke-token" } })
);

const proc = spawn(process.execPath, [binPath, "--provider-url", providerUrl, "--cache-root", cacheRoot], {
  env: { ...process.env, PDPP_OWNER_SESSION_COOKIE: "", PDPP_OWNER_TOKEN: "" },
});

let stdoutBuf = "";
let stderrBuf = "";
proc.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
});
proc.stderr.on("data", (chunk) => {
  stderrBuf += chunk.toString("utf8");
});

function sendMessage(msg) {
  proc.stdin.write(`${JSON.stringify(msg)}\n`);
}

await new Promise((resolve) => setTimeout(resolve, 500));

sendMessage({
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
    protocolVersion: "2025-06-18",
  },
});

// Wait for initialize response.
await waitFor(() => stdoutBuf.includes('"id":1'), 3000);

sendMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
sendMessage({ id: 2, jsonrpc: "2.0", method: "tools/list" });

await waitFor(() => stdoutBuf.includes('"id":2'), 3000);

proc.kill("SIGTERM");
rs.close();

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const lines = stdoutBuf.split("\n").filter((line) => line.length > 0);
const parsed = lines.map((line, index) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`stdout line ${index} is not valid JSON: ${JSON.stringify(line)}`);
  }
});

const result = {
  ok: true,
  stderr_excerpt: stderrBuf.split("\n").slice(0, 4),
  stdout_lines: parsed.length,
  tool_names: parsed.flatMap((msg) => (msg?.result?.tools ?? []).map((tool) => tool.name)).sort(),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
