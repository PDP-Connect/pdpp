// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hard-memory oracle for hosted `/v1/ingest/:stream`.
 *
 * The constrained Docker container runs only the reference server. The load
 * generator runs in this parent process, outside the server cgroup, so OOM
 * classification describes the hosted server container rather than a combined
 * server/client synthetic process.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { issueOwnerToken } from "../server/auth.ts";
import { closeDb } from "../server/db.ts";
import { HOSTED_INGEST_MAX_REQUEST_BYTES } from "../server/hosted-ingest-limits.ts";
import { startServer } from "../server/index.ts";

const CONNECTOR_ID = "memory-oracle";
const STREAM = "items";
const MIB = 1024 * 1024;
const READY_PREFIX = "PDPP_MEMORY_ORACLE_READY ";
const DEFAULT_AS_PORT = 17_662;
const DEFAULT_RS_PORT = 17_663;

interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

interface DockerState {
  readonly error: string;
  readonly exitCode: number | null;
  readonly oomKilled: boolean;
  readonly running: boolean;
}

interface ReadyPayload {
  readonly as_port: number;
  readonly connector_id: string;
  readonly max_request_bytes: number;
  readonly rs_port: number;
  readonly stream: string;
  readonly token: string;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
};

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function numberArg(name: string, fallback: number): number {
  const raw = argValue(name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return Math.floor(parsed);
}

function stringArg(name: string, fallback: string): string {
  return argValue(name) ?? fallback;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function invalidUtf8Ndjson(totalBytes: number, includeTrailingNewline: boolean): Readable {
  let newlineSent = !includeTrailingNewline;
  let remaining = totalBytes;
  return new Readable({
    read() {
      if (remaining > 0) {
        const size = Math.min(remaining, 64 * 1024);
        remaining -= size;
        this.push(Buffer.alloc(size, 0xff));
        return;
      }
      if (!newlineSent) {
        newlineSent = true;
        this.push(Buffer.from("\n"));
        return;
      }
      this.push(null);
    },
  });
}

async function closeServer(server: StartedServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolveClose) => server.asServer.close(resolveClose)),
    new Promise((resolveClose) => server.rsServer.close(resolveClose)),
  ]);
  closeDb();
}

async function registerConnector(asUrl: string): Promise<void> {
  const response = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify({
      connector_id: CONNECTOR_ID,
      connector_key: CONNECTOR_ID,
      display_name: "Hosted ingest memory oracle",
      protocol_version: "0.1.0",
      streams: [
        {
          name: STREAM,
          primary_key: ["id"],
          schema: {
            properties: { id: { type: "string" } },
            required: ["id"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
      ],
      version: "1.0.0",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 201, `register connector failed: ${response.status} ${await response.text()}`);
}

async function runServerChild(): Promise<void> {
  const asPort = numberArg("--as-port", DEFAULT_AS_PORT);
  const rsPort = numberArg("--rs-port", DEFAULT_RS_PORT);
  process.env.PDPP_RECORD_REJECTION_CONNECTION_QUOTA_BYTES = String(HOSTED_INGEST_MAX_REQUEST_BYTES + MIB);
  process.env.PDPP_RECORD_REJECTION_OWNER_QUOTA_BYTES = String(HOSTED_INGEST_MAX_REQUEST_BYTES + MIB);
  const tmp = mkdtempSync(`${tmpdir()}/pdpp-hosted-ingest-memory-`);
  const server = (await startServer({
    asPort,
    dbPath: `${tmp}/pdpp.sqlite`,
    ownerAuthPassword: "",
    quiet: true,
    rsPort,
  })) as StartedServer;

  const shutdown = async () => {
    await closeServer(server);
    process.exit(0);
  };
  process.once("SIGINT", () => {
    shutdown().catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
  });
  process.once("SIGTERM", () => {
    shutdown().catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
  });

  await registerConnector(`http://127.0.0.1:${asPort}`);
  const token = await issueOwnerToken("owner_local");
  const ready: ReadyPayload = {
    as_port: asPort,
    connector_id: CONNECTOR_ID,
    max_request_bytes: HOSTED_INGEST_MAX_REQUEST_BYTES,
    rs_port: rsPort,
    stream: STREAM,
    token,
  };
  console.log(`${READY_PREFIX}${JSON.stringify(ready)}`);
  await new Promise(() => undefined);
}

function dockerImage(): string {
  return stringArg("--image", "node:22-bookworm-slim");
}

function memoryLimit(): string {
  return stringArg("--memory", "200m");
}

function containerName(): string {
  return `pdpp-ingest-memory-${process.pid}-${Date.now()}`;
}

function runDocker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function inspectContainer(name: string): DockerState | null {
  try {
    const raw = runDocker(["inspect", name, "--format", "{{json .State}}"]);
    const parsed = JSON.parse(raw) as {
      Error?: string;
      ExitCode?: number;
      OOMKilled?: boolean;
      Running?: boolean;
    };
    return {
      error: parsed.Error ?? "",
      exitCode: typeof parsed.ExitCode === "number" ? parsed.ExitCode : null,
      oomKilled: Boolean(parsed.OOMKilled),
      running: Boolean(parsed.Running),
    };
  } catch {
    return null;
  }
}

function removeContainer(name: string): void {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}

function waitForReady(name: string, timeoutMs: number): ReadyPayload {
  const deadline = Date.now() + timeoutMs;
  let lastLogs = "";
  while (Date.now() < deadline) {
    const state = inspectContainer(name);
    if (state && !state.running) {
      const logs = spawnSync("docker", ["logs", name], { encoding: "utf8", stdio: "pipe" });
      throw new Error(`server container exited before ready: ${JSON.stringify(state)}\n${logs.stdout}${logs.stderr}`);
    }
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8", stdio: "pipe" });
    lastLogs = `${logs.stdout}${logs.stderr}`;
    const readyLine = lastLogs.split("\n").find((line) => line.startsWith(READY_PREFIX));
    if (readyLine) {
      return JSON.parse(readyLine.slice(READY_PREFIX.length)) as ReadyPayload;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`timed out waiting for server readiness\n${lastLogs}`);
}

async function fetchText(url: string, opts: RequestInit = {}): Promise<{ status: number; text: string }> {
  const response = await fetch(url, opts);
  return { status: response.status, text: await response.text() };
}

async function assertServerLive(rsPort: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${rsPort}/.well-known/oauth-protected-resource`);
  assert.equal(response.status, 200, `protected-resource metadata readiness failed: ${response.status}`);
  const body = (await response.json()) as { resource?: unknown };
  assert.equal(typeof body.resource, "string", "protected-resource metadata must include resource");
  return response.status;
}

async function driveIngest(ready: ReadyPayload, lineBytes: number, expect: string, containerNameForState: string) {
  const includeTrailingNewline = !hasFlag("--no-trailing-newline");
  const url = new URL(`http://127.0.0.1:${ready.rs_port}/v1/ingest/${ready.stream}`);
  url.searchParams.set("connector_id", ready.connector_id);
  let response: { status: number; text: string };
  try {
    response = await fetchText(url.toString(), {
      body: invalidUtf8Ndjson(lineBytes, includeTrailingNewline),
      duplex: "half",
      headers: {
        Authorization: `Bearer ${ready.token}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
      signal: AbortSignal.timeout(numberArg("--request-timeout-ms", 120_000)),
    } as RequestInit & { duplex: "half" });
  } catch (err) {
    const state = inspectContainer(containerNameForState);
    throw new Error(`ingest request failed; server_state=${JSON.stringify(state)}`, { cause: err });
  }

  if (expect === "success") {
    assert.equal(response.status, 200, `expected 200, got ${response.status}: ${response.text.slice(0, 300)}`);
    const body = JSON.parse(response.text) as {
      records_attempted?: number;
      records_rejected?: number;
      rejections?: Array<{ code?: string; input_index?: number; receipt_id?: string }>;
    };
    assert.equal(body.records_attempted, 1);
    assert.equal(body.records_rejected, 1);
    assert.equal(body.rejections?.length, 1);
    assert.equal(body.rejections[0]?.code, "invalid_utf8");
    assert.equal(body.rejections[0]?.input_index, 0);
    assert.equal(typeof body.rejections[0]?.receipt_id, "string");
  } else if (expect === "refusal") {
    assert.equal(response.status, 413, `expected 413, got ${response.status}: ${response.text.slice(0, 300)}`);
    const body = JSON.parse(response.text) as { code?: string; error?: { code?: string } };
    const code = body.error?.code ?? body.code;
    assert.equal(code, "FST_ERR_CTP_BODY_TOO_LARGE", `unexpected 413 body: ${response.text.slice(0, 300)}`);
  } else {
    throw new Error(`unknown --expect ${expect}`);
  }
  return response.status;
}

function classifyFailure(state: DockerState | null): string {
  if (!state) {
    return "missing";
  }
  if (state.oomKilled) {
    return "oom";
  }
  if (state.running) {
    return "running";
  }
  return `exited_${state.exitCode ?? "unknown"}`;
}

async function runParent(): Promise<void> {
  const asPort = numberArg("--as-port", DEFAULT_AS_PORT);
  const expect = stringArg("--expect", "success");
  const lineBytes = numberArg("--line-bytes", 8 * MIB);
  const name = containerName();
  const rsPort = numberArg("--rs-port", DEFAULT_RS_PORT);
  let cleaned = false;
  const cleanup = () => {
    if (!cleaned) {
      cleaned = true;
      removeContainer(name);
    }
  };
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    runDocker([
      "run",
      "-d",
      "--name",
      name,
      "--memory",
      memoryLimit(),
      "--memory-swap",
      memoryLimit(),
      "--network",
      "host",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,nodev,size=512m",
      "-v",
      `${repoRoot()}:/work:ro`,
      "-w",
      "/work/reference-implementation",
      dockerImage(),
      "node",
      "--import",
      "tsx",
      "scripts/hosted-ingest-memory-cgroup.ts",
      "--server-child",
      "--as-port",
      String(asPort),
      "--rs-port",
      String(rsPort),
    ]);

    const ready = waitForReady(name, 30_000);
    await assertServerLive(ready.rs_port);
    const responseStatus = await driveIngest(ready, lineBytes, expect, name);
    const liveStatus = await assertServerLive(ready.rs_port);
    const stateAfterProbe = inspectContainer(name);
    assert.equal(stateAfterProbe?.running, true, `server must still be running: ${JSON.stringify(stateAfterProbe)}`);
    console.log(
      JSON.stringify({
        classification: classifyFailure(stateAfterProbe),
        image: dockerImage(),
        line_bytes: lineBytes,
        live_status: liveStatus,
        max_request_bytes: ready.max_request_bytes,
        memory: memoryLimit(),
        response_status: responseStatus,
        server_container: name,
        trailing_newline: !hasFlag("--no-trailing-newline"),
      })
    );
  } finally {
    const stateBeforeCleanup = inspectContainer(name);
    if (stateBeforeCleanup && !stateBeforeCleanup.running) {
      console.error(`server_container_final_state=${JSON.stringify(stateBeforeCleanup)}`);
    }
    cleanup();
  }
}

if (hasFlag("--server-child")) {
  await runServerChild();
} else {
  await runParent();
}
