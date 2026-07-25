// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface RunInstalledStdioProbeOptions {
  binPath: string;
  consumerRoot: string;
  nodePath?: string;
}

interface InstalledStdioProbeResult {
  stderr: string[];
  toolContract: string;
  toolResultVersion: unknown;
}

interface JsonRpcMessage {
  id?: number;
  jsonrpc: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: {
    isError?: boolean;
    serverInfo?: { name?: string };
    structuredContent?: { data?: { version?: unknown } };
  };
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out waiting for stdio MCP response"));
      }
    }, 25);
  });
}

export async function runInstalledStdioProbe({
  consumerRoot,
  binPath,
  nodePath = process.execPath,
}: RunInstalledStdioProbeOptions): Promise<InstalledStdioProbeResult> {
  const cacheRoot = await mkdtemp(join(tmpdir(), "pdpp-mcp-artifact-"));
  const rs = createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://127.0.0.1").pathname === "/v1/schema") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ version: "artifact-proof", streams: ["orders"] }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not_found" } }));
  });

  await new Promise<void>((resolve) => rs.listen(0, "127.0.0.1", resolve));
  const address = rs.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const providerUrl = `http://127.0.0.1:${port}`;
  const host = new URL(providerUrl).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  await mkdir(join(cacheRoot, "clients"), { recursive: true });
  await writeFile(
    join(cacheRoot, "clients", `${host}.json`),
    JSON.stringify({ credential: { access_token: "artifact-token" } })
  );

  const proc = spawn(nodePath, [binPath, "--provider-url", providerUrl, "--cache-root", cacheRoot], {
    cwd: consumerRoot,
    env: { ...process.env, PDPP_OWNER_TOKEN: "", PDPP_OWNER_SESSION_COOKIE: "" },
  });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  function send(message: JsonRpcMessage): void {
    proc.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "emitted-artifact-probe", version: "1" },
      },
    });
    await waitFor(() => stdout.includes('"id":1'), 3000);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "schema", arguments: {} } });
    await waitFor(() => stdout.includes('"id":2'), 3000);

    const messages: JsonRpcMessage[] = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonRpcMessage);
    const initialize = messages.find((message) => message.id === 1);
    const schema = messages.find((message) => message.id === 2);
    assert.equal(initialize?.result?.serverInfo?.name, "pdpp-mcp-server", "installed server must complete initialize");
    assert.equal(
      schema?.result?.structuredContent?.data?.version,
      "artifact-proof",
      `installed schema tool must reach the RS: ${JSON.stringify(schema)}`
    );
    assert.equal(schema?.result?.isError, undefined, "installed schema tool must succeed");
    return {
      stderr: stderr.split("\n").filter(Boolean).slice(0, 2),
      toolContract: "schema",
      toolResultVersion: schema?.result?.structuredContent?.data?.version,
    };
  } finally {
    proc.kill("SIGTERM");
    rs.close();
  }
}
