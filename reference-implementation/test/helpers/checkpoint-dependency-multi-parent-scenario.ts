// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared multi-parent `DETAIL_COVERAGE` scenario for genuine SQLite/Postgres
 * parity: one detail stream (`valuations`) fed by two independently
 * checkpointed parents (`holdings`, `activity`); one parent proves complete
 * coverage and commits, the other's coverage is incomplete and stays
 * uncommitted. Both `checkpoint-dependency-profile-conformance.test.ts`
 * (SQLite) and `checkpoint-dependency-profile-conformance-postgres.test.ts`
 * (Postgres) invoke this SAME function against their own backend so the
 * assertions are provably identical scenarios, not two independently
 * authored tests that happen to look similar.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { runConnector as RunConnectorType } from "../../runtime/index.ts";

type RunConnectorFn = typeof RunConnectorType;

const REACTIONS_STREAM_NAME_PATTERN = /reactions/;
const STATIC_STATE_STREAM_VIOLATION_PATTERN = /MUST NOT emit DETAIL_COVERAGE/;
const UNRELATED_PARENT_NAME_PATTERN = /unrelated_parent/;

interface FetchJsonResult<T> {
  body: T;
  status: number;
}

async function fetchJson<T = unknown>(url: string, opts: RequestInit = {}): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "u1"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
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

export function fakeAdmitRunConnection<Store>(
  admitOwnerRunConnection: (input: {
    connectorId: string;
    connectorInstanceId: string | null;
    connectorInstanceStore: Store;
    ownerSubjectId: string;
  }) => Promise<{ connectorId: string; connectorInstanceId: string }>,
  createRequestConnectorInstanceStore: () => Store,
  ownerSubjectIdDefault = "u1"
): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || ownerSubjectIdDefault;
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

export function multiParentManifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "holdings",
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
      },
      {
        name: "activity",
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
      },
      {
        coverage_strategy: "parent_detail_accounting",
        name: "valuations",
        parent_streams: ["holdings", "activity"],
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

function writeConnectorStub(tmpDir: string, script: string): string {
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  ${script}
});
`,
    "utf8"
  );
  return connectorPath;
}

/**
 * Runs the multi-parent scenario against whichever backend `asUrl`/`rsUrl`
 * point at, using the caller's own `runConnector` and admission wiring
 * (each backend's test file imports its OWN copy of the real production
 * `runConnector`/`admitOwnerRunConnection`/`createRequestConnectorInstanceStore`
 * modules — this helper only supplies the shared scenario data and
 * assertions, never a reimplementation of the algorithm itself).
 */
export async function runMultiParentScenario<Store>({
  asUrl,
  rsUrl,
  runConnector,
  admitOwnerRunConnection,
  createRequestConnectorInstanceStore,
  connectorId,
}: {
  asUrl: string;
  rsUrl: string;
  runConnector: RunConnectorFn;
  admitOwnerRunConnection: Parameters<typeof fakeAdmitRunConnection<Store>>[0];
  createRequestConnectorInstanceStore: Parameters<typeof fakeAdmitRunConnection<Store>>[1];
  connectorId: string;
}): Promise<void> {
  const manifest = multiParentManifest(connectorId);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-checkpoint-profile-multiparent-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'holdings', key: 'H', data: { id: 'H' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'activity', key: 'A', data: { id: 'A' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, stream: 'valuations', state_stream: 'holdings', required_keys: ['H'], hydrated_keys: [] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, stream: 'valuations', state_stream: 'activity', required_keys: ['A'], hydrated_keys: ['A'] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'holdings', cursor: { page: 'holdings-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'activity', cursor: { page: 'activity-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(admitOwnerRunConnection, createRequestConnectorInstanceStore),
      collectionMode: "incremental",
      connectorId: manifest.connector_id,
      connectorPath,
      manifest,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl,
      state: null,
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.checkpoint_summary?.state_streams_staged, 2);
    assert.equal(
      result.checkpoint_summary?.state_streams_committed,
      1,
      "the proven activity cursor commits while the incomplete holdings cursor remains retryable"
    );

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(stateResp.status, 200);
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state, { activity: { page: "activity-1" } });
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

// -----------------------------------------------------------------------
// Manifest-authority scenarios (checkpoint dependency P1-2): live
// DETAIL_COVERAGE evidence is validated against the manifest's declared
// parent shape, never allowed to introduce an undeclared parent or override
// a static state_stream declaration. Shared by both the SQLite and Postgres
// conformance test files so the parity claim compares identical scenarios.
// -----------------------------------------------------------------------

export function staticParentManifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "messages",
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
      },
      {
        name: "unrelated_channel",
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
      },
      {
        coverage_strategy: "checkpoint_window",
        name: "reactions",
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
        state_stream: "messages",
      },
    ],
    version: "0.1.0",
  };
}

/**
 * Case 1 + case 6: a stream declared with a static `state_stream` parent
 * (`reactions` -> `messages`) MUST NOT ever emit DETAIL_COVERAGE. A buggy
 * connector that does so — here naming a DIFFERENT in-scope live
 * `state_stream` (`unrelated_channel`) than the manifest's static
 * declaration (`messages`), matching the review's concrete unsafe sequence —
 * must be rejected as a protocol violation, and the rejection must prevent
 * any checkpoint from advancing, not merely throw and leave the run's
 * outcome unverified.
 */
export async function runStaticParentEmitsCoverageScenario<Store>({
  asUrl,
  rsUrl,
  runConnector,
  admitOwnerRunConnection,
  createRequestConnectorInstanceStore,
  connectorId,
}: {
  asUrl: string;
  rsUrl: string;
  runConnector: RunConnectorFn;
  admitOwnerRunConnection: Parameters<typeof fakeAdmitRunConnection<Store>>[0];
  createRequestConnectorInstanceStore: Parameters<typeof fakeAdmitRunConnection<Store>>[1];
  connectorId: string;
}): Promise<void> {
  const manifest = staticParentManifest(connectorId);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-checkpoint-static-coverage-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'unrelated_channel', key: 'u-1', data: { id: 'u-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'unrelated_channel', cursor: { cursor: 'unrelated-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, stream: 'reactions', state_stream: 'unrelated_channel', required_keys: ['m-1'], hydrated_keys: ['m-1'] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    let rejection: Error | null = null;
    try {
      await runConnector({
        admitRunConnection: fakeAdmitRunConnection(admitOwnerRunConnection, createRequestConnectorInstanceStore),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      });
    } catch (err) {
      rejection = err as Error;
    }

    assert.ok(rejection, "a state_stream-declared stream emitting DETAIL_COVERAGE must be rejected");
    assert.match(
      rejection?.message || "",
      REACTIONS_STREAM_NAME_PATTERN,
      "the rejection must name the offending stream"
    );
    assert.match(
      rejection?.message || "",
      STATIC_STATE_STREAM_VIOLATION_PATTERN,
      "the rejection must cite the static state_stream protocol violation, not an unrelated cause"
    );

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(stateResp.status, 200);
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(
      stateBody.state,
      {},
      "no checkpoint may advance once the connector violates the static state_stream contract"
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

export function undeclaredParentManifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "messages",
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
      },
      {
        name: "unrelated_parent",
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
      },
      {
        coverage_strategy: "parent_detail_accounting",
        name: "attachments",
        parent_streams: ["messages"],
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

/**
 * Case 2: a `parent_streams`-declared stream emits DETAIL_COVERAGE naming a
 * live `state_stream` NOT in its declared set. This is the "undeclared
 * parent" unsafe sequence at the heart of P1-2: the manifest declares only
 * `messages` as attachments' parent, but the connector's live evidence
 * claims a checkpoint relationship to `unrelated_parent`, which the manifest
 * never authorized.
 */
export async function runUndeclaredParentScenario<Store>({
  asUrl,
  rsUrl,
  runConnector,
  admitOwnerRunConnection,
  createRequestConnectorInstanceStore,
  connectorId,
}: {
  asUrl: string;
  rsUrl: string;
  runConnector: RunConnectorFn;
  admitOwnerRunConnection: Parameters<typeof fakeAdmitRunConnection<Store>>[0];
  createRequestConnectorInstanceStore: Parameters<typeof fakeAdmitRunConnection<Store>>[1];
  connectorId: string;
}): Promise<void> {
  const manifest = undeclaredParentManifest(connectorId);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-checkpoint-undeclared-parent-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'unrelated_parent', key: 'u-1', data: { id: 'u-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'unrelated_parent', cursor: { cursor: 'unrelated-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, stream: 'attachments', state_stream: 'unrelated_parent', required_keys: ['u-1'], hydrated_keys: ['u-1'] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    let rejection: Error | null = null;
    try {
      await runConnector({
        admitRunConnection: fakeAdmitRunConnection(admitOwnerRunConnection, createRequestConnectorInstanceStore),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      });
    } catch (err) {
      rejection = err as Error;
    }

    assert.ok(rejection, "DETAIL_COVERAGE naming an undeclared parent must be rejected");
    assert.match(
      rejection?.message || "",
      UNRELATED_PARENT_NAME_PATTERN,
      "the rejection must name the undeclared parent"
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
}

export function subsetParentManifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "a",
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
      },
      {
        name: "b",
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
      },
      {
        coverage_strategy: "parent_detail_accounting",
        name: "detail",
        parent_streams: ["a", "b"],
        primary_key: ["id"],
        selection: { fields: true, resources: true },
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

/**
 * Case 3 + 4: live evidence covers only a proper subset of the declared
 * parent set (only "a" reports this run; "b" gets no DETAIL_COVERAGE at
 * all). The manifest still declares both "a" and "b" as attachments'
 * parents, so "b" must be withheld as unproven — not silently dropped from
 * the dependency set (which would make it appear self-mapped/unconstrained)
 * and not silently treated as satisfied.
 */
export async function runSubsetParentCoverageScenario<Store>({
  asUrl,
  rsUrl,
  runConnector,
  admitOwnerRunConnection,
  createRequestConnectorInstanceStore,
  connectorId,
}: {
  asUrl: string;
  rsUrl: string;
  runConnector: RunConnectorFn;
  admitOwnerRunConnection: Parameters<typeof fakeAdmitRunConnection<Store>>[0];
  createRequestConnectorInstanceStore: Parameters<typeof fakeAdmitRunConnection<Store>>[1];
  connectorId: string;
}): Promise<void> {
  const manifest = subsetParentManifest(connectorId);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-checkpoint-subset-parent-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'b', key: 'b-1', data: { id: 'b-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, stream: 'detail', state_stream: 'a', required_keys: ['a-1'], hydrated_keys: ['a-1'] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'a', cursor: { page: 'a-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'b', cursor: { page: 'b-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(admitOwnerRunConnection, createRequestConnectorInstanceStore),
      collectionMode: "incremental",
      connectorId: manifest.connector_id,
      connectorPath,
      manifest,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl,
      state: null,
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.checkpoint_summary?.state_streams_staged, 2);
    assert.equal(
      result.checkpoint_summary?.state_streams_committed,
      1,
      "only the proven 'a' boundary commits; 'b' has no coverage report at all this run and must be withheld"
    );

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(stateResp.status, 200);
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(
      stateBody.state,
      { a: { page: "a-1" } },
      "'b' must not be silently dropped from the dependency set nor treated as satisfied"
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
}
