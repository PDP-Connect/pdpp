// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression oracle for runtime-owned fetch failures. Node exposes these as
// `TypeError: fetch failed`; the useful code/socket facts are nested in
// Error.cause. This exercises the real child-message failure -> terminal Spine
// event -> run_history writer seam, because a helper-only assertion would not
// prove the owner-visible /sources diagnostic changed.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { runConnector } from "../runtime/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const CONNECTOR_ID = "runtime-failure-diagnostic-test";

before(() => {
  initDb(":memory:");
});

after(() => {
  closeDb();
});

function createConnector(messages: readonly Record<string, unknown>[], exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-runtime-failure-diagnostic-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  for (const message of ${JSON.stringify(messages)}) process.stdout.write(JSON.stringify(message) + '\\n');
  rl.close();
  process.exit(${exitCode});
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

function readStoredConnectorError(runId: string): Record<string, unknown> {
  const row = getDb().prepare("SELECT connector_error_json FROM run_history WHERE run_id = ?").get(runId) as {
    connector_error_json?: string | null;
  };
  assert.ok(row.connector_error_json, "the terminal runtime failure must reach run_history.connector_error_json");
  return JSON.parse(row.connector_error_json);
}

async function runWithProgressFailure(runId: string, error: Error): Promise<Record<string, unknown>> {
  const { cleanup, connectorPath } = createConnector([{ message: "collecting", type: "PROGRESS" }]);
  try {
    await assert.rejects(() =>
      runConnector({
        admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => ({
          connectorId,
          connectorInstanceId: connectorInstanceId ?? `${connectorId}:default`,
          ownerSubjectId: ownerSubjectId ?? "owner_local",
        }),
        connectorId: CONNECTOR_ID,
        connectorPath,
        manifest: {
          connector_id: CONNECTOR_ID,
          streams: [{ name: "items" }],
        },
        onInteraction: async () => ({}),
        onProgress: (message) => {
          if (message && typeof message === "object" && (message as { type?: unknown }).type === "PROGRESS") {
            throw error;
          }
        },
        ownerToken: "test-owner-token",
        persistState: false,
        runId,
        scope: { streams: [{ name: "items" }] },
      })
    );
    return readStoredConnectorError(runId);
  } finally {
    cleanup();
  }
}

function fetchFailure(cause: Record<string, unknown>): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("untrusted cause message"), cause) });
}

test("a thrown fetch TypeError persists its nested code and safe socket facts", async () => {
  const stored = await runWithProgressFailure(
    "run_runtime_fetch_connect_timeout",
    fetchFailure({
      address: "203.0.113.8",
      code: "UND_ERR_CONNECT_TIMEOUT",
      hostname: "api.example.test",
      port: 443,
      syscall: "connect",
    })
  );

  assert.deepEqual(stored, {
    cause_chain: [
      {
        address: "203.0.113.8",
        code: "UND_ERR_CONNECT_TIMEOUT",
        port: 443,
        syscall: "connect",
      },
    ],
    code: "UND_ERR_CONNECT_TIMEOUT",
    message: "fetch failed",
    origin: "runtime",
    retryable: true,
  });
});

test("runtime diagnostics mark DNS failures retryable and certificate failures non-retryable", async (t) => {
  await t.test("DNS", async () => {
    const stored = await runWithProgressFailure(
      "run_runtime_fetch_dns_failure",
      fetchFailure({ code: "ENOTFOUND", hostname: "missing.example.test", syscall: "getaddrinfo" })
    );
    assert.equal(stored.code, "ENOTFOUND");
    assert.equal(stored.retryable, true);
  });

  await t.test("certificate", async () => {
    const stored = await runWithProgressFailure(
      "run_runtime_fetch_certificate_failure",
      fetchFailure({ code: "CERT_HAS_EXPIRED", hostname: "expired.example.test" })
    );
    assert.equal(stored.code, "CERT_HAS_EXPIRED");
    assert.equal(stored.retryable, false);
  });
});

test("runtime diagnostics never persist a hostname from an arbitrary cause", async () => {
  const hostname = "untrusted-hostname-that-must-not-reach-run-history.example.test";
  const stored = await runWithProgressFailure(
    "run_runtime_fetch_host_omitted",
    fetchFailure({ address: "not-an-ip-address", code: "ENOTFOUND", hostname, syscall: "getaddrinfo" })
  );

  assert.equal(JSON.stringify(stored).includes(hostname), false);
  assert.equal(JSON.stringify(stored).includes("not-an-ip-address"), false);
  assert.deepEqual(stored.cause_chain, [{ code: "ENOTFOUND", syscall: "getaddrinfo" }]);
});

test("a connector-reported DONE error remains unchanged", async () => {
  const runId = "run_connector_reported_failure_unchanged";
  const { cleanup, connectorPath } = createConnector(
    [
      {
        error: { code: "ordinary_failure", message: "ordinary connector failure", retryable: false },
        records_emitted: 0,
        status: "failed",
        type: "DONE",
      },
    ],
    1
  );
  try {
    const result = await runConnector({
      admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => ({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? `${connectorId}:default`,
        ownerSubjectId: ownerSubjectId ?? "owner_local",
      }),
      connectorId: CONNECTOR_ID,
      connectorPath,
      manifest: { connector_id: CONNECTOR_ID, streams: [{ name: "items" }] },
      onInteraction: async () => ({}),
      onProgress: () => {
        // The connector-reported terminal error is the observable under test.
      },
      ownerToken: "test-owner-token",
      persistState: false,
      runId,
      scope: { streams: [{ name: "items" }] },
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(readStoredConnectorError(runId), {
      code: "ordinary_failure",
      message: "ordinary connector failure",
      retryable: false,
    });
  } finally {
    cleanup();
  }
});
