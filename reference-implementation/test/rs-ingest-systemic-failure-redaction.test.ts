// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Security proof for the ingest-rejection contract revision.
//
// RecordsIngestSystemicFailureError's message is built from
// classifyIngestFailure's catch-all classification: any error a host does
// not recognize (in production, a raw SQLite/Postgres driver error) defaults
// systemic/retryable. Driver errors routinely embed SQL fragments,
// bound-parameter values, or other storage-internal detail — record data,
// in the worst case, if a parameter is echoed into the driver's own error
// text. A prior revision of this fix threaded that raw message straight
// into `RecordsIngestSystemicFailureError`'s public `.message`, which
// `rs-mutation.ts` copies verbatim into BOTH the HTTP 503 response body
// (via `rejectMutation` -> `pdppError`) AND the persisted `mutation.rejected`
// spine event (an owner-facing "trace show" artifact readable via
// `GET /_ref/traces/:traceId`, not an internal-only sink) — an unredacted
// external leak of internal storage detail.
//
// This suite proves the CURRENT fix: `rs-mutation.ts` maps every
// `RecordsIngestSystemicFailureError` to a single fixed public message
// before it ever reaches `rejectMutation`, so the underlying failure's own
// text never interpolates into the response. A distinctive, deliberately
// secret-shaped marker injected into a real systemic failure's message must
// appear NOWHERE in the HTTP response body or the externally-readable
// persisted rejection event.
//
// Drives the REAL server end to end (startServer, real HTTP, the real
// GET /_ref/traces/:traceId trace endpoint) — no mocks of rejectMutation,
// pdppError, or the spine event pipeline, so the proof covers the actual
// external boundary, not a stand-in for it. The systemic failure itself is
// injected via records.ts's pre-existing `__setIngestFaultHookForTest` test
// seam (the same one records-ingest-batch-coordination.test.ts already
// uses) — not connector-instance-write-coordinator.ts, which is never
// imported or touched here.

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { startServer } from "../server/index.ts";
import { __setIngestFaultHookForTest } from "../server/records.ts";

// The reference owner-auth placeholder gate (server/owner-auth.ts) activates
// whenever PDPP_OWNER_PASSWORD is set in the process environment, requiring
// a real /device/approve login before /oauth/token issues a bearer. The real
// `npm test` runner (scripts/test-env.ts's buildScrubbedTestEnv) strips this
// var before spawning; a direct `node --test` invocation does not. Clearing
// it locally around this one test keeps the OAuth device flow open in
// either invocation, without touching global env for any other test file.
function withoutOwnerPassword(t: TestContext): void {
  const previous = process.env.PDPP_OWNER_PASSWORD;
  delete process.env.PDPP_OWNER_PASSWORD;
  t.after(() => {
    if (previous !== undefined) {
      process.env.PDPP_OWNER_PASSWORD = previous;
    }
  });
}

// Deliberately NOT credential-shaped, despite this file's name. The fix under
// test is not a pattern-based redactor: `RecordsIngestSystemicFailureError`'s
// message is a fixed, bounded template that never interpolates the underlying
// failure's text, so NOTHING here matches this marker against a credential
// pattern — every assertion below is a plain `includes` check. The marker only
// has to be distinctive enough to find, which means reshaping it cannot weaken
// the proof. The earlier live-Stripe-key shape made GitHub's push protection
// block every push of this branch; a scanner matches shape and cannot tell a
// canary from a real key.
const SECRET_MARKER = "canary_DoNotLeakThisRecordSecretMarker9f3a";
const PUBLIC_MESSAGE = "Ingest failed due to a transient storage error; retry later.";

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
    display_name: "Redaction Probe Connector",
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: false },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
}

interface ReferenceTraceEvent {
  data: Record<string, unknown>;
  event_type: string;
  request_id: string | null;
}

interface ReferenceTraceResponse {
  data: ReferenceTraceEvent[];
}

test("a secret-shaped marker in a systemic failure's underlying message never appears in the HTTP response or the persisted mutation.rejected event", async (t) => {
  withoutOwnerPassword(t);
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const rsUrl = `http://localhost:${rsPort}`;
  const connectorId = "redaction-probe";
  await registerManifest(asUrl, manifest(connectorId));
  const ownerToken = await issueOwnerToken(asUrl);

  // A real, unclassified error whose message embeds a distinctive marker —
  // standing in for what a raw SQLite/Postgres driver error can legitimately
  // contain (SQL text, bound parameters, which can be record field values).
  // No .code is set, so classifyIngestFailure defaults it retryable: true —
  // genuinely systemic, not a fabricated shortcut around classification.
  __setIngestFaultHookForTest((point: string) => {
    if (point === "after-records-mutation") {
      throw new Error(
        `duplicate key value violates unique constraint "records_pkey": Key (record_key)=(${SECRET_MARKER}) already exists`
      );
    }
  });

  try {
    // POST /v1/ingest/:stream is mounted on the RS app (rsPort), not the AS
    // app (asPort) — mirroring runtime/index.ts's own flushBatch, which
    // posts to opts.rsUrl.
    const resp = await fetchJson(`${rsUrl}/v1/ingest/items?connector_id=${connectorId}`, {
      body: JSON.stringify({ data: { id: "r1" }, key: "r1" }),
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/x-ndjson" },
      method: "POST",
    });

    assert.equal(resp.status, 503, "a systemic failure must surface as a non-2xx retryable status");
    const rawBody = JSON.stringify(resp.body);
    assert.ok(
      !rawBody.includes(SECRET_MARKER),
      `HTTP response body must never contain the underlying driver error's marker; got: ${rawBody}`
    );
    assert.ok(
      !(rawBody.toLowerCase().includes("unique constraint") || rawBody.toLowerCase().includes("records_pkey")),
      `HTTP response body must never contain SQL/schema-internal detail; got: ${rawBody}`
    );

    const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
    assert.ok(traceId, "the rejected response must carry a reference trace id");
    const { body: traceBody } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId ?? "")}`);
    const trace = traceBody as ReferenceTraceResponse;
    const rejectedEvent = trace.data.find((event) => event.event_type === "mutation.rejected");
    assert.ok(rejectedEvent, "the real persisted mutation.rejected event must exist for this trace");
    const rawEvent = JSON.stringify(rejectedEvent);
    assert.ok(
      !rawEvent.includes(SECRET_MARKER),
      `the externally-readable persisted mutation.rejected event must never contain the underlying driver error's marker; got: ${rawEvent}`
    );
    assert.ok(
      !(rawEvent.toLowerCase().includes("unique constraint") || rawEvent.toLowerCase().includes("records_pkey")),
      `the persisted mutation.rejected event must never contain SQL/schema-internal detail; got: ${rawEvent}`
    );

    // Positive control: the public message IS the fixed, bounded template —
    // proving the redaction is not accidentally hiding EVERYTHING (a bug
    // that would also, wrongly, pass the negative assertions above).
    const errorBody = resp.body as { error?: { code?: string; message?: string } };
    assert.equal(errorBody.error?.code, "ingest_batch_storage_error");
    assert.equal(errorBody.error?.message, PUBLIC_MESSAGE);
  } finally {
    __setIngestFaultHookForTest(null);
    await closeServer(server);
  }
});
