// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression coverage for OpenSpec change
// `harden-ingest-against-transient-manifest-drift`.
//
// Reproduces the live GitHub `user_stats` failure shape: the runtime admits a
// stream into START scope from the manifest it was handed, but the resource
// server's *registered* manifest lags (a stale connectors row), so that stream's
// ingest is rejected 404 `not_found`. The runtime must treat this as a transient
// per-stream gap — skip the stream, keep its cursor uncommitted, and still commit
// every other in-scope stream — instead of aborting the whole run.
//
// The drift is constructed honestly against a REAL resource server: we register a
// manifest WITHOUT the drift stream (so the RS 404s it) while passing a manifest
// WITH the drift stream to runConnector (so the runtime validates it into START
// scope). No mocks of the ingest path.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isTransientManifestDriftIngestFailure, loadSyncState, runConnector } from "../runtime/index.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

/**
 * Admission fixture for `runConnector`'s required `admitRunConnection`
 * callback. Mirrors the production wiring in `server/index.ts`
 * (`createController({ admitRunConnection: ... })`): calls the real
 * `admitOwnerRunConnection` against a request-scoped connector-instance
 * store, materializing the caller's default-account row for
 * `OWNER_AUTH_DEFAULT_SUBJECT_ID` ('owner_local' — this file's
 * `issueOwnerToken` default). Both tests here ingest through the real RS,
 * which validates the resolved instance id against that same real store.
 */
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

const REGEXP_1 = /undeclared stream: not_in_scope/;

// ── local harness (kept self-contained; mirrors collection-profile.test.js) ──

async function fetchJson(url: string, init?: RequestInit): Promise<{ body: unknown; status: number }> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
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

function streamSchema() {
  return {
    properties: { id: { type: "string" }, value: { type: "string" } },
    required: ["id"],
    type: "object",
  };
}

// Manifest as the RESOURCE SERVER sees it: only `items` (the drift stream is
// absent, simulating a stale connectors row).
function rsRegisteredManifest(connectorId: string) {
  return {
    connector_id: connectorId,
    display_name: "Drift Test Connector",
    protocol_version: "0.1.0",
    streams: [{ name: "items", primary_key: ["id"], schema: streamSchema(), semantics: "append_only" }],
    version: "1.0.0",
  };
}

// Manifest as the RUNTIME sees it: `items` + the drift stream. The runtime
// validates the drift stream into START scope; the RS will still 404 it.
function runtimeManifest(connectorId: string) {
  return {
    ...rsRegisteredManifest(connectorId),
    streams: [
      { name: "items", primary_key: ["id"], schema: streamSchema(), semantics: "append_only" },
      { name: "drift_stream", primary_key: ["id"], schema: streamSchema(), semantics: "append_only" },
    ],
  };
}

function createTestConnector(messages: Record<string, unknown>[]) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-drift-connector-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const script = `
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    const done = [...messages].reverse().find((m) => m.type === 'DONE') || null;
    const exitCode = !done ? 0 : (done.status === 'succeeded' ? 0 : 1);
    for (const m of messages) process.stdout.write(JSON.stringify(m) + '\\n');
    rl.close();
    process.exit(exitCode);
  }
});
`;
  writeFileSync(connectorPath, script, "utf-8");
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

async function registerManifest(asUrl: string, manifest: Record<string, unknown>): Promise<void> {
  await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
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

const nowIso = () => new Date().toISOString();

test("transient manifest drift: scope-stream ingest not_found degrades to a per-stream gap", async (t) => {
  await t.test("drift stream is skipped, other streams commit, run succeeds", async () => {
    const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
    const { asPort, rsPort } = server;
    const asUrl = `http://localhost:${asPort}`;
    const connectorId = "drift-test";
    await registerManifest(asUrl, rsRegisteredManifest(connectorId)); // RS lacks drift_stream
    const ownerToken = await issueOwnerToken(asUrl);

    // items ingests fine (200); drift_stream 404s (RS manifest lacks it).
    const { connectorPath, cleanup } = createTestConnector([
      { data: { id: "i1", value: "ok" }, emitted_at: nowIso(), key: "i1", stream: "items", type: "RECORD" },
      { cursor: { cursor: "items_committed" }, stream: "items", type: "STATE" },
      { data: { id: "d1", value: "drift" }, emitted_at: nowIso(), key: "d1", stream: "drift_stream", type: "RECORD" },
      { cursor: { cursor: "drift_should_not_commit" }, stream: "drift_stream", type: "STATE" },
      { records_emitted: 2, status: "succeeded", type: "DONE" },
    ]);

    try {
      const result = await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "full_refresh",
        connectorId,
        connectorPath,
        manifest: runtimeManifest(connectorId), // runtime scope INCLUDES drift_stream
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl: `http://localhost:${rsPort}`,
        scope: { streams: [{ name: "items" }, { name: "drift_stream" }] },
        state: null,
      });

      // Run is NOT aborted by the drift 404.
      assert.equal(result.status, "succeeded", "run should succeed despite drift stream 404");

      // A transient known gap names the drift stream.
      const driftGap = (result.known_gaps || []).find((g) => g.stream === "drift_stream") as
        | { reason?: string; severity?: string; stream?: string }
        | undefined;
      assert.ok(driftGap, "a known gap should name drift_stream");
      assert.equal(driftGap.reason, "manifest_stream_unresolved");
      assert.equal(driftGap.severity, "transient");

      // The healthy stream committed its cursor; the drift stream did NOT.
      const state = (await loadSyncState(connectorId, ownerToken, { rsUrl: `http://localhost:${rsPort}` })) as Record<
        string,
        { cursor?: string } | undefined
      > | null;
      assert.equal(state?.items?.cursor, "items_committed", "items cursor should be committed");
      assert.ok(
        state.drift_stream?.cursor !== "drift_should_not_commit",
        "drift stream cursor must NOT be committed so the next run re-collects it"
      );

      assert.ok(result.run_id, "expected a run_id on the successful outcome");

      // The healthy stream's record reached the RS.
      const { body: itemsBody } = await fetchJson(
        `http://localhost:${rsPort}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      const itemsRecords = itemsBody as { data?: unknown[]; records?: unknown[] };
      assert.ok((itemsRecords.data || itemsRecords.records || []).length >= 1, "items record should be ingested");

      // Timeline shows a stream_skipped for the drift stream and NOT a run.failed.
      const { body: timeline } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(result.run_id)}/timeline`);
      const events =
        (timeline as { data?: { data?: Record<string, unknown>; event_type: string; stream_id?: string }[] }).data ||
        [];
      const types = events.map((e) => e.event_type);
      assert.ok(types.includes("run.stream_skipped"), "timeline should include run.stream_skipped");
      assert.ok(types.includes("run.completed"), "timeline should include run.completed");
      assert.ok(!types.includes("run.failed"), "timeline should NOT include run.failed");
      const skip = events.find((e) => e.event_type === "run.stream_skipped");
      assert.ok(skip, "expected a run.stream_skipped event");
      assert.equal(skip.stream_id, "drift_stream");
      assert.equal(skip.data?.reason, "manifest_stream_unresolved");
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test("a genuinely unknown-to-runtime stream still fails terminally (guard)", async () => {
    // Here the drift stream is NOT in the runtime manifest/scope either, so a
    // RECORD for it is an undeclared-stream protocol violation — the runtime must
    // still fail. This proves the fix does not silently accept records for
    // streams the runtime never validated.
    const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
    const { asPort, rsPort } = server;
    const asUrl = `http://localhost:${asPort}`;
    const connectorId = "drift-guard";
    await registerManifest(asUrl, rsRegisteredManifest(connectorId));
    const ownerToken = await issueOwnerToken(asUrl);

    const { connectorPath, cleanup } = createTestConnector([
      { data: { id: "x1" }, emitted_at: nowIso(), key: "x1", stream: "not_in_scope", type: "RECORD" },
      { records_emitted: 1, status: "succeeded", type: "DONE" },
    ]);

    try {
      // The runtime rejects an undeclared-stream RECORD as a protocol violation
      // BEFORE any ingest — it never reaches flushBatch, so the drift branch can
      // never mask it. This must remain terminal.
      await assert.rejects(
        () =>
          runConnector({
            admitRunConnection: fakeAdmitRunConnection(),
            collectionMode: "full_refresh",
            connectorId,
            connectorPath,
            manifest: rsRegisteredManifest(connectorId), // runtime scope EXCLUDES not_in_scope
            onInteraction: async () => ({}),
            ownerToken,
            persistState: true,
            rsUrl: `http://localhost:${rsPort}`,
            scope: { streams: [{ name: "items" }] },
            state: null,
          }),
        (err: unknown) => {
          const typed = err as { failure_reason?: string; message?: string };
          assert.equal(typed.failure_reason, "connector_protocol_violation");
          assert.match(typed.message ?? "", REGEXP_1);
          return true;
        },
        "undeclared-stream RECORD must still fail the run terminally"
      );
    } finally {
      cleanup();
      await closeServer(server);
    }
  });

  await t.test("predicate reclassifies ONLY a 404 not_found for an in-scope stream", () => {
    const inScope = (s: string) => s === "items";
    const runtimeError = (fields: {
      ingest_failure?: { http_status: number; phase: string };
      pdpp_error_code: string;
      response_status: number;
    }) => Object.assign(new Error("test runtime error"), fields);
    const driftErr = runtimeError({
      ingest_failure: { http_status: 404, phase: "http_response" },
      pdpp_error_code: "not_found",
      response_status: 404,
    });

    // Positive: the exact transient-drift shape for an in-scope stream.
    assert.equal(isTransientManifestDriftIngestFailure(driftErr, "items", inScope), true);

    // Negative — stream is NOT in START scope (never validated against manifest).
    assert.equal(isTransientManifestDriftIngestFailure(driftErr, "other", inScope), false);

    // Negative — a different status (400 ambiguous_connector_instance, 5xx, 401).
    for (const status of [400, 401, 403, 409, 500, 503]) {
      const err = runtimeError({
        ...driftErr,
        ingest_failure: { http_status: status, phase: "http_response" },
        response_status: status,
      });
      assert.equal(
        isTransientManifestDriftIngestFailure(err, "items", inScope),
        false,
        `HTTP ${status} must NOT be reclassified as transient drift`
      );
    }

    // Negative — 404 but a different error code (e.g. connector-level not_found).
    assert.equal(
      isTransientManifestDriftIngestFailure(
        runtimeError({ ...driftErr, pdpp_error_code: "grant_invalid" }),
        "items",
        inScope
      ),
      false
    );

    // Negative — 404 not_found but not the ingest http_response phase.
    assert.equal(
      isTransientManifestDriftIngestFailure(
        runtimeError({ ...driftErr, ingest_failure: { http_status: 404, phase: "request" } }),
        "items",
        inScope
      ),
      false
    );

    // Negative — no ingest_failure envelope at all (a plain 404 elsewhere).
    assert.equal(
      isTransientManifestDriftIngestFailure(
        runtimeError({ pdpp_error_code: "not_found", response_status: 404 }),
        "items",
        inScope
      ),
      false
    );

    // Negative — nullish error.
    assert.equal(isTransientManifestDriftIngestFailure(null, "items", inScope), false);
  });
});
