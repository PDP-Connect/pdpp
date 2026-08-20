// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Diagnosability proof for the ingest-rejection contract.
//
// RecordsIngestSystemicFailureError's client-visible `.message` is
// deliberately a fixed, bounded template (see
// rs-ingest-systemic-failure-redaction.test.ts) — the underlying driver
// error's own message (which can carry SQL fragments or bound-parameter
// values) must never reach the HTTP response or the persisted
// mutation.rejected event.
//
// Before this fix, that redaction left the real cause of a systemic/retryable
// ingest failure visible NOWHERE AT ALL: `ingestRecordsWithinCoordinator`'s
// per-record catch (server/records.ts) classified the error and stored it
// only on the in-memory outcome — no log statement, no structured evidence.
// Operators had only "ingest_batch_storage_error" and a fixed count to go on,
// with zero way to tell a transient storage hiccup from (e.g.) a
// statement_timeout or a schema-shape defect specific to one connector's
// records. This suite proves the fix: the real classified failure (connector
// instance, run id, stream, code, message) is written to the server log,
// while the external redaction contract from
// rs-ingest-systemic-failure-redaction.test.ts is untouched.

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { __setIngestFaultHookForTest } from "../server/records.ts";

function withoutOwnerPassword(t: TestContext): void {
  const previous = process.env.PDPP_OWNER_PASSWORD;
  delete process.env.PDPP_OWNER_PASSWORD;
  t.after(() => {
    if (previous !== undefined) {
      process.env.PDPP_OWNER_PASSWORD = previous;
    }
  });
}

// Deliberately NOT credential-shaped. This marker only has to be distinctive
// enough to find in a log line and prove it never reaches the HTTP body — the
// assertions below are plain `includes` checks and never parse it. An earlier
// value was shaped like a live Stripe key, which is a better story but made
// every push of this file trip GitHub's secret scanner: a pattern matcher
// cannot tell a canary from a real key, so it blocked the whole push. The
// redaction contract itself is owned by
// `rs-ingest-systemic-failure-redaction.test.ts`, not by this string's shape.
const SECRET_MARKER = "canary_ServerLogOnlyMarkerNeverInHttpBody";

async function fetchJson(
  url: string,
  init?: RequestInit
): Promise<{ body: unknown; status: number; headers: Headers }> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, headers: resp.headers, status: resp.status };
}

interface ClosableServer {
  asServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  rsServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (srv: { close: (cb: () => void) => void }) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      srv.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function registerManifest(asUrl: string, connectorManifest: Record<string, unknown>): Promise<void> {
  await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(connectorManifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

interface DeviceAuthorizationBody {
  device_code: string;
  user_code: string;
}

interface TokenBody {
  access_token: string;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = body as DeviceAuthorizationBody;
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return (tokenBody as TokenBody).access_token;
}

function manifest(connectorId: string) {
  return {
    connector_id: connectorId,
    display_name: "Server Log Probe Connector",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
}

test("a systemic ingest failure's real cause is written to the server log even though the HTTP response stays redacted", async (t) => {
  withoutOwnerPassword(t);
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const rsUrl = `http://localhost:${rsPort}`;
  const connectorId = "server-log-probe";
  await registerManifest(asUrl, manifest(connectorId));
  const ownerToken = await issueOwnerToken(asUrl);

  __setIngestFaultHookForTest((point: string) => {
    if (point === "after-records-mutation") {
      throw new Error(
        `duplicate key value violates unique constraint "records_pkey": Key (record_key)=(${SECRET_MARKER}) already exists`
      );
    }
  });

  const capturedErrorLogs: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    capturedErrorLogs.push(args.map((a) => String(a)).join(" "));
  };

  try {
    const resp = await fetchJson(`${rsUrl}/v1/ingest/items?connector_id=${connectorId}`, {
      body: JSON.stringify({ data: { id: "r1" }, key: "r1" }),
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
      method: "POST",
    });
    assert.equal(resp.status, 503, "a systemic failure must still surface as a non-2xx retryable status");

    // FAIL-BEFORE / PASS-AFTER: before this fix, ingestRecordsWithinCoordinator's
    // per-record catch stored the classified failure only on the in-memory
    // outcome — nothing was ever written to the server log. This assertion is
    // what a pre-fix checkout fails.
    const matching = capturedErrorLogs.filter(
      (line) => line.includes("[records] ingest") && line.includes(SECRET_MARKER)
    );
    assert.ok(
      matching.length > 0,
      `expected the server log to contain the real (unredacted) failure detail; got logs: ${JSON.stringify(capturedErrorLogs)}`
    );
    assert.ok(
      matching.some((line) => line.includes("stream=items") && line.includes("retryable=true")),
      `expected the log line to name the stream and retryability; got: ${JSON.stringify(matching)}`
    );

    // The external redaction contract (rs-ingest-systemic-failure-redaction.test.ts)
    // must be completely unaffected by this change: the HTTP body still never
    // contains the secret marker or SQL-internal detail.
    const rawBody = JSON.stringify(resp.body);
    assert.ok(
      !rawBody.includes(SECRET_MARKER),
      `HTTP response body must never contain the driver error's marker; got: ${rawBody}`
    );
  } finally {
    console.error = originalConsoleError;
    __setIngestFaultHookForTest(null);
    await closeServer(server);
  }
});
