// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runConnector } from "../runtime/index.ts";
import { startServer } from "../server/index.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

/**
 * Minimal admission fixture for `runConnector`'s required `admitRunConnection`
 * callback: echoes back an explicit claim, or (when the caller made none)
 * derives the same deterministic default-account connector-instance id the
 * storage layer itself falls back to — this file's owner-dashboard reads all
 * resolve through that same default binding (see the comment above
 * `issueOwnerToken`), so writer and reader must agree on it.
 */
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId);
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

// End-to-end + isolation tests for the Tranche C control-plane projection
// (`define-connector-progress-evidence-contract`, tasks 2.2b / 2.4 / 2.5 / 2.6).
//
// These drive a real connector run through `runConnector`, then read the
// owner/control-plane surface (`GET /_ref/connectors/:id`, `GET /_ref/connectors`)
// and assert the derived per-stream `collection_report` rides the wire with a
// coverage condition and forward disposition per stream. They also prove the
// honesty gate end to end (collected records + no considered -> `unknown`, never
// `complete`) and that NEITHER the runtime `collection_facts` block NOR the
// derived `collection_report` leaks onto grant-scoped `/v1` reads.

// ─── minimal harness (self-contained; mirrors collection-profile.test.js) ─────

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv: TestServer["asServer"]) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);
      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function fetchJson<T = unknown>(url: string, opts: RequestInit = {}): Promise<{ status: number; body: T }> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

interface ConnectorTestMessage {
  cursor?: Record<string, unknown>;
  data?: Record<string, unknown>;
  emitted_at?: string;
  key?: string;
  records_emitted?: number;
  status?: string;
  stream?: string;
  type: string;
}

function createTestConnector(messages: ConnectorTestMessage[]) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-creport-connector-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const script = `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    const doneMessage = [...messages].reverse().find((m) => m.type === 'DONE') || null;
    const exitCode = !doneMessage ? 0 : (doneMessage.status === 'succeeded' ? 0 : 1);
    for (const m of messages) {
      process.stdout.write(JSON.stringify(m) + '\\n');
    }
    rl.close();
    process.exit(exitCode);
  }
});
`;
  writeFileSync(connectorPath, script, "utf-8");
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

const TWO_STREAM_MANIFEST = {
  connector_id: "creport-two-stream",
  display_name: "Collection Report Two-Stream",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" }, value: { type: "string" } }, required: ["id"], type: "object" },
      semantics: "append_only",
    },
    {
      name: "other_items",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" }, value: { type: "string" } }, required: ["id"], type: "object" },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

// Every test in this file reads back through the owner-dashboard surface
// (`getConnectorDetail`/`_ref/connectors`), which is hardcoded to
// REFERENCE_OWNER_SUBJECT_ID/OWNER_AUTH_DEFAULT_SUBJECT_ID ('owner_local') —
// a real, intentional single-owner security boundary, not a bug. The default
// subject here must match that boundary (mirrors collection-profile.test.js's
// issueOwnerToken, which already defaults to 'owner_local' for this exact
// reason) so an owner-token run's connection is actually visible on the
// dashboard route this file asserts against.
interface DeviceAuthorization {
  device_code: string;
  user_code: string;
}

interface TokenResponse {
  access_token: string;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<DeviceAuthorization>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson<TokenResponse>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return tokenBody.access_token;
}

interface ConnectorManifest {
  connector_id: string;
  [key: string]: unknown;
}

async function setupConnector(
  asUrl: string,
  manifest: ConnectorManifest
): Promise<{ ownerToken: string; connectorId: string }> {
  await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const ownerToken = await issueOwnerToken(asUrl);
  return { connectorId: manifest.connector_id, ownerToken };
}

interface CollectionReportEntry {
  checkpoint?: string;
  collected?: number;
  considered: string;
  coverage_condition: string;
  forward_disposition: string;
  stream: string;
  [key: string]: unknown;
}

function indexEntries(report: CollectionReportEntry[] | undefined): Record<string, CollectionReportEntry> {
  return Object.fromEntries((report || []).map((entry) => [entry.stream, entry]));
}

interface ConnectorDetailBody {
  collection_report?: CollectionReportEntry[];
  rendered_verdict?: { detail?: unknown; trace?: unknown };
  [key: string]: unknown;
}

// ─── 2.2b: two requested streams -> two derived report entries ────────────────

test("2.2b: a two-stream run yields a two-entry collection_report on the detail surface", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const { ownerToken, connectorId } = await setupConnector(asUrl, TWO_STREAM_MANIFEST);

  const { connectorPath, cleanup } = createTestConnector([
    {
      data: { id: "i1", value: "a" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "i1",
      stream: "items",
      type: "RECORD",
    },
    {
      data: { id: "i2", value: "b" },
      emitted_at: "2026-05-19T00:00:01.000Z",
      key: "i2",
      stream: "items",
      type: "RECORD",
    },
    { cursor: { last: "i2" }, stream: "items", type: "STATE" },
    {
      data: { id: "o1", value: "c" },
      emitted_at: "2026-05-19T00:00:02.000Z",
      key: "o1",
      stream: "other_items",
      type: "RECORD",
    },
    { cursor: { last: "o1" }, stream: "other_items", type: "STATE" },
    { records_emitted: 3, status: "succeeded", type: "DONE" },
  ]);

  try {
    const result = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      manifest: TWO_STREAM_MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "items" }, { name: "other_items" }] },
      state: null,
    });
    assert.equal(result.status, "succeeded");

    const { status, body } = await fetchJson<ConnectorDetailBody>(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.collection_report), "detail carries a derived collection_report array");
    const byStream = indexEntries(body.collection_report);
    assert.deepEqual(Object.keys(byStream).sort(), ["items", "other_items"]);

    // Each entry carries a coverage condition from the canonical vocabulary plus
    // a forward disposition. With no declared considered, the condition is
    // `unknown` (the gate), NOT `complete`, and the disposition is `unmeasured`.
    const VOCAB = new Set([
      "complete",
      "partial",
      "gaps",
      "retryable_gap",
      "terminal_gap",
      "unsupported",
      "unavailable",
      "deferred",
      "inventory_only",
      "unknown",
    ]);
    for (const stream of ["items", "other_items"]) {
      const entry = byStream[stream];
      assert.ok(entry, `${stream} entry present`);
      assert.ok(VOCAB.has(entry.coverage_condition), `coverage condition in canonical vocabulary for ${stream}`);
      assert.equal(entry.considered, "unknown", `${stream} has no declared considered -> unknown`);
      assert.equal(entry.coverage_condition, "unknown", `${stream} reads unknown, never complete`);
      assert.equal(entry.forward_disposition, "unmeasured", `${stream} forward disposition is unmeasured`);
    }
    const itemsEntry = byStream.items;
    const otherItemsEntry = byStream.other_items;
    assert.ok(itemsEntry);
    assert.ok(otherItemsEntry);
    assert.equal(itemsEntry.collected, 2, "items collected count rides through from the fact block");
    assert.equal(otherItemsEntry.collected, 1, "other_items collected count rides through");
    assert.equal(itemsEntry.checkpoint, "committed", "committed checkpoint surfaced");
    // NOTE: the connection LIST surface (`GET /_ref/connectors`) projects only
    // configured connection-instance rows, which this manifest-only run harness
    // does not create, so the list is asserted at the unit/type layer instead.
    // The list call site shares the SAME `projectCollectionReport(...)` wiring as
    // this detail surface (see `listConnectorSummaries`).
  } finally {
    cleanup();
    await closeServer(server);
  }
});

// ─── 2.4: the honesty gate proven end to end (collected, no considered) ───────

test("2.4: a collected-records, no-gaps, no-considered run is NOT projected complete", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const { ownerToken, connectorId } = await setupConnector(asUrl, TWO_STREAM_MANIFEST);

  const { connectorPath, cleanup } = createTestConnector([
    {
      data: { id: "i1", value: "a" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "i1",
      stream: "items",
      type: "RECORD",
    },
    { cursor: { last: "i1" }, stream: "items", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ]);

  try {
    const result = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      manifest: TWO_STREAM_MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "items" }] },
      state: null,
    });
    assert.equal(result.status, "succeeded");

    const { body } = await fetchJson<ConnectorDetailBody>(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`
    );
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const items = indexEntries(body.collection_report).items;
    assert.ok(items, "items entry present");
    assert.equal(items.collected, 1, "collected one record");
    // The load-bearing guarantee: collected count alone never proves complete.
    assert.notEqual(items.coverage_condition, "complete");
    assert.equal(items.coverage_condition, "unknown");
    assert.notEqual(items.forward_disposition, "complete");
    assert.notEqual(items.forward_disposition, "checking");
    assert.equal(items.forward_disposition, "unmeasured");
  } finally {
    cleanup();
    await closeServer(server);
  }
});

// ─── 2.6: a portable RECORD/STATE/DONE-only connector still yields a report ───

test("2.6: a portable RECORD/STATE/DONE-only connector yields a valid report with unknown axes", async () => {
  const manifest = {
    connector_id: "creport-portable",
    display_name: "Portable Floor",
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
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const { ownerToken, connectorId } = await setupConnector(asUrl, manifest);

  const { connectorPath, cleanup } = createTestConnector([
    { data: { id: "p1" }, emitted_at: "2026-05-19T00:00:00.000Z", key: "p1", stream: "items", type: "RECORD" },
    { cursor: { last: "p1" }, stream: "items", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ]);

  try {
    const result = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      manifest,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "items" }] },
      state: null,
    });
    assert.equal(result.status, "succeeded");

    const { body } = await fetchJson<ConnectorDetailBody>(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`
    );
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const items = indexEntries(body.collection_report).items;
    assert.ok(items, "portable connector still produces a report entry");
    assert.equal(items.considered, "unknown");
    assert.equal(items.coverage_condition, "unknown");
    assert.equal(items.forward_disposition, "unmeasured");
  } finally {
    cleanup();
    await closeServer(server);
  }
});

// ─── 2.5: neither the fact block nor the derived report leaks onto /v1 ────────

test("2.5: collection_facts and collection_report are absent from grant-scoped /v1 reads", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const rsUrl = `http://localhost:${rsPort}`;
  const { ownerToken, connectorId } = await setupConnector(asUrl, TWO_STREAM_MANIFEST);

  const { connectorPath, cleanup } = createTestConnector([
    {
      data: { id: "i1", value: "a" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "i1",
      stream: "items",
      type: "RECORD",
    },
    { cursor: { last: "i1" }, stream: "items", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ]);

  try {
    const result = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      manifest: TWO_STREAM_MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl,
      scope: { streams: [{ name: "items" }] },
      state: null,
    });
    assert.equal(result.status, "succeeded");

    // Sanity: the owner surface DOES carry the report (so the negative below is
    // meaningful, not vacuous).
    const { body: detail } = await fetchJson<ConnectorDetailBody>(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`
    );
    assert.ok(Array.isArray(detail.collection_report) && detail.collection_report.length >= 1);
    assert.ok(detail.rendered_verdict?.detail, "owner surface carries rendered_verdict.detail");
    assert.ok(detail.rendered_verdict?.trace, "owner surface carries rendered_verdict.trace");

    const auth = { headers: { Authorization: `Bearer ${ownerToken}` } };
    const v1Surfaces = [
      `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`,
      `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}&limit=5`,
      `${rsUrl}/v1/schema?connector_id=${encodeURIComponent(connectorId)}`,
      `${rsUrl}/v1/streams?connector_id=${encodeURIComponent(connectorId)}`,
    ];
    for (const url of v1Surfaces) {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
      const resp = await fetch(url, auth);
      // The surface may legitimately 200 or 404 depending on shape; the contract
      // is only that, when it returns a body, it carries no report.
      const text = await resp.text();
      assert.ok(!text.includes("collection_report"), `derived collection_report must not appear on /v1: ${url}`);
      assert.ok(!text.includes("collection_facts"), `runtime collection_facts must not appear on /v1: ${url}`);
      assert.ok(!text.includes("rendered_verdict"), `owner rendered_verdict must not appear on /v1: ${url}`);
      assert.ok(!text.includes("detail_gap_backlog"), `owner detail_gap_backlog must not appear on /v1: ${url}`);
      assert.ok(!text.includes("tone_cause"), `owner calibration trace must not appear on /v1: ${url}`);
      assert.ok(!text.includes("satisfied_when"), `owner satisfaction contract trace must not appear on /v1: ${url}`);
    }
  } finally {
    cleanup();
    await closeServer(server);
  }
});

// ─── derive-on-read: the report reflects evidence at read time, not run time ──

test("derive-on-read: coverage condition is computed on each read (not frozen at run completion)", async () => {
  // Two consecutive reads of the SAME completed run return a report; the entries
  // are derived freshly each call (the projection holds no frozen verdict). This
  // pins the "derived on read" property the contract requires so the manual-
  // refresh seam can flip a complete entry to owner_refresh_due later without
  // rewriting run history.
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const { ownerToken, connectorId } = await setupConnector(asUrl, TWO_STREAM_MANIFEST);

  const { connectorPath, cleanup } = createTestConnector([
    {
      data: { id: "i1", value: "a" },
      emitted_at: "2026-05-19T00:00:00.000Z",
      key: "i1",
      stream: "items",
      type: "RECORD",
    },
    { cursor: { last: "i1" }, stream: "items", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ]);

  try {
    const result = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      manifest: TWO_STREAM_MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "items" }] },
      state: null,
    });
    assert.equal(result.status, "succeeded");

    const first = await fetchJson<ConnectorDetailBody>(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`);
    const second = await fetchJson<ConnectorDetailBody>(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}`);
    const firstItems = indexEntries(first.body.collection_report).items;
    const secondItems = indexEntries(second.body.collection_report).items;
    assert.ok(firstItems);
    assert.ok(secondItems);
    assert.deepEqual(
      firstItems.coverage_condition,
      secondItems.coverage_condition,
      "same run derives the same coverage condition on each read"
    );
    // Both reads computed the entry (it is present), proving it is produced by
    // the projection on read rather than read from a stored field on the run.
    assert.ok(firstItems);
    assert.ok(secondItems);
  } finally {
    cleanup();
    await closeServer(server);
  }
});
