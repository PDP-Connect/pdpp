// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the wiring, not just the resolver.
 *
 * `test/connector-run-config-resolution.test.ts` proves that
 * `resolveRunConnectorOptions` refuses a proposed revision. That is a claim
 * about a function. This file proves the claim that actually matters to an
 * owner: what a REAL connector process receives on its stdin at run start.
 *
 * A connector is spawned for each case and writes the START message it
 * received to a file. The assertions read that file. So these tests fail if
 * the runtime stops calling the resolver, stops threading the result into
 * START, or names the field something other than `connector_options` (the
 * field `packages/polyfill-connectors/src/connector-options.ts` reads).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type RuntimeRunConnectorOptions, runConnector } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import type { ConfigRevision } from "../server/stores/connector-instance-config-store.ts";

const CONNECTION_ID = "cin_slack_1";
const NOW = "2026-08-23T10:00:00.000Z";

const MINIMAL_MANIFEST = {
  connector_id: "test",
  display_name: "Test Connector",
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

/**
 * A connector that records the START message it received and exits cleanly.
 * Deliberately a real child process: the point is to observe the wire, not a
 * function's return value.
 */
function createStartCaptureConnector(capturePath: string) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-config-start-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const script = `
import { createInterface } from 'readline';
import { writeFileSync } from 'node:fs';

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(msg, null, 2));
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`;
  writeFileSync(connectorPath, script, "utf-8");
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

function revision(config: Record<string, unknown>, status: ConfigRevision["status"]): ConfigRevision {
  return {
    collectionBoundaryFingerprint: null,
    config,
    configContractId: "pdpp.connector_config.v1",
    configContractVersion: 1,
    confirmedAt: status === "active" ? NOW : null,
    confirmedBy: status === "active" ? "owner-1" : null,
    connectorInstanceId: CONNECTION_ID,
    isExplicit: true,
    optionKind: "collection_scope",
    origin: "agent",
    revision: 1,
    setAt: NOW,
    setBy: "agent-session-7",
    sourceOfChange: "test",
    status,
  };
}

/**
 * Run a capture connector and return the START message it received.
 *
 * `persistState: false` and a stub `admitRunConnection` keep this off the
 * database and off the RS; the run emits no records, so no ingest happens.
 */
async function captureStart(
  connectorConfigStore: RuntimeRunConnectorOptions["connectorConfigStore"]
): Promise<Record<string, unknown>> {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-config-capture-"));
  const capturePath = join(tmpDir, "start.json");
  const { cleanup, connectorPath } = createStartCaptureConnector(capturePath);
  // The runtime reclaims stranded detail-gap leases before START, which needs
  // an open database. The config store itself is stubbed per-test.
  initDb(":memory:");
  try {
    const result = (await runConnector({
      admitRunConnection: () =>
        Promise.resolve({
          connectorId: "test",
          connectorInstanceId: CONNECTION_ID,
          ownerSubjectId: "owner-1",
        }),
      connectorConfigStore,
      connectorId: "test",
      connectorInstanceId: CONNECTION_ID,
      connectorPath,
      manifest: MINIMAL_MANIFEST as unknown as RuntimeRunConnectorOptions["manifest"],
      onInteraction: null,
      onProgress: () => undefined,
      ownerSubjectId: "owner-1",
      ownerToken: "test-token",
      persistState: false,
      state: null,
    } as RuntimeRunConnectorOptions)) as { status: string };
    assert.equal(result.status, "succeeded");
    return JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>;
  } finally {
    cleanup();
    rmSync(tmpDir, { force: true, recursive: true });
    closeDb();
  }
}

test("ACCEPTANCE: a PROPOSED revision never appears in the START a real connector receives", async () => {
  const start = await captureStart({
    // The store reports null for a proposed revision -- exactly what
    // getActiveRevision does when the pointer does not name an active one.
    getActiveRevision: () => Promise.resolve(null),
  });

  assert.equal(start.type, "START");
  assert.ok(
    !Object.hasOwn(start, "connector_options"),
    "an unconfirmed revision must not put connector_options on the wire at all -- " +
      "readOptions must fall through to the connector's manifest defaults"
  );
});

test("MUTATION PROOF: the SAME config, once ACTIVE, does reach the connector as START.connector_options", async () => {
  const config = { CHANNEL_ALLOWLIST: ["C_OWNER_CONFIRMED"], MEMBER_ONLY: true };
  const start = await captureStart({
    getActiveRevision: () => Promise.resolve(revision(config, "active")),
  });

  assert.equal(start.type, "START");
  assert.deepEqual(
    start.connector_options,
    config,
    "an owner-confirmed revision must be delivered under the field readOptions reads"
  );
});

test("a connection with no active revision omits connector_options entirely", async () => {
  const start = await captureStart({ getActiveRevision: () => Promise.resolve(null) });
  assert.ok(!Object.hasOwn(start, "connector_options"));
});

test("an unreadable config store FAILS CLOSED: the run still starts, with no connector_options", async () => {
  const start = await captureStart({
    getActiveRevision: () => Promise.reject(new Error("database is locked")),
  });

  // Fail-closed must not mean fail-stop: an unreadable config store degrades
  // to manifest defaults rather than killing an otherwise-valid run.
  assert.equal(start.type, "START");
  assert.ok(!Object.hasOwn(start, "connector_options"));
});

test("connector_options does not disturb the rest of the START contract", async () => {
  const start = await captureStart({
    getActiveRevision: () => Promise.resolve(revision({ SKIP_FILES: true }, "active")),
  });

  assert.equal(start.type, "START");
  assert.deepEqual(start.connector_options, { SKIP_FILES: true });
  // The fields the protocol already guaranteed are still present and correct.
  assert.equal(start.collection_mode, "incremental");
  assert.ok(Array.isArray((start.scope as { streams?: unknown[] }).streams));
  assert.deepEqual(
    (start.scope as { streams: { name: string }[] }).streams.map((s) => s.name),
    ["items"]
  );
  assert.ok(Object.hasOwn(start, "run_id"));
});
