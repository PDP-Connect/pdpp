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
    connector_id: connectorId,
    streams: [
      {
        name: "holdings",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
      {
        name: "activity",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
      {
        coverage_strategy: "parent_detail_accounting",
        name: "valuations",
        parent_streams: ["holdings", "activity"],
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
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
