// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Records-list page-limit contract: an over-max `limit` is clamped to the
 * spec-core §8 maximum (100) and the reduction is surfaced via a structured
 * `limit_clamped` entry in the canonical `meta.warnings[]` envelope — never
 * silently. A request within the cap produces no such warning.
 *
 * This closes the silent-clamp token-efficiency gap: an agent that
 * optimistically asks for `limit=500` gets a valid bounded page AND learns the
 * effective page size, instead of reasoning against a 500-record page it never
 * received.
 *
 * Exercises the SQLite reference path directly via `queryRecords`, mirroring
 * `records-meta-window.test.js`, plus the shared `clampRecordsPageLimit`
 * helper that both the SQLite and Postgres record paths use.
 *
 * Contract: spec-core.md §8 ("List records") — "Records per page. Default 25,
 * max 100."; openspec/changes/add-records-limit-clamp-warning.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import {
  ingestRecord,
  queryRecords,
  queryRecordsAcrossBindings,
} from '../server/records.js';
import { registerConnector } from '../server/auth.js';
import { resolveFanInBindings } from '../server/connection-identity.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';
import {
  CANONICAL_WARNING_CODES,
  RECORDS_DEFAULT_PAGE_LIMIT,
  RECORDS_MAX_PAGE_LIMIT,
  clampRecordsPageLimit,
} from '../server/connection-id-request.js';

const CONNECTOR_ID = 'limit-clamp';
const STREAM = 'messages';
const INSTANCE_A = 'cin_limit_clamp_account_a';
const INSTANCE_B = 'cin_limit_clamp_account_b';

const manifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Limit-clamp Test Connector',
  capabilities: { human_interaction: [] },
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      cursor_field: 'received_at',
      schema: {
        type: 'object',
        required: ['id', 'subject', 'received_at'],
        properties: {
          id: { type: 'string' },
          subject: { type: 'string' },
          received_at: { type: 'string', format: 'date-time' },
        },
      },
    },
  ],
};

const grant = {
  streams: [{ name: STREAM, fields: ['id', 'subject', 'received_at'] }],
};

function target(connectorId, instanceId) {
  return { connector_id: connectorId, connector_instance_id: instanceId };
}

function recordPayload(index) {
  // Zero-padded so lexical key order matches numeric order; received_at is
  // strictly increasing so the page is deterministic regardless of order.
  const id = `rec-${String(index).padStart(4, '0')}`;
  const received_at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
  return {
    stream: STREAM,
    key: id,
    data: { id, subject: `subject ${index}`, received_at },
    emitted_at: received_at,
  };
}

async function seedInstance(instanceId, displayName, bindingKey) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorInstanceId: instanceId,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    connectorId: CONNECTOR_ID,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey: bindingKey,
    sourceBinding: { account: bindingKey },
    createdAt: now,
    updatedAt: now,
  });
}

async function withSeededDb(recordCount, testFn) {
  initDb();
  try {
    await registerConnector(manifest);
    await seedInstance(INSTANCE_A, 'Account A', 'a@example.com');
    for (let i = 0; i < recordCount; i += 1) {
      await ingestRecord(target(CONNECTOR_ID, INSTANCE_A), recordPayload(i));
    }
    await testFn();
  } finally {
    closeDb();
  }
}

async function withDualConnectionDb(perInstanceCount, testFn) {
  initDb();
  try {
    await registerConnector(manifest);
    await seedInstance(INSTANCE_A, 'Account A', 'a@example.com');
    await seedInstance(INSTANCE_B, 'Account B', 'b@example.com');
    for (let i = 0; i < perInstanceCount; i += 1) {
      await ingestRecord(target(CONNECTOR_ID, INSTANCE_A), recordPayload(i));
      await ingestRecord(target(CONNECTOR_ID, INSTANCE_B), recordPayload(i));
    }
    await testFn();
  } finally {
    closeDb();
  }
}

function findLimitClampedWarning(response) {
  const warnings = response?.meta?.warnings;
  if (!Array.isArray(warnings)) return null;
  return warnings.find((w) => w?.code === CANONICAL_WARNING_CODES.LIMIT_CLAMPED) ?? null;
}

// ─── clampRecordsPageLimit: helper-level coverage ────────────────────────────

test('clampRecordsPageLimit returns the default and no clamp when limit is absent', () => {
  assert.deepEqual(clampRecordsPageLimit(undefined), {
    limit: RECORDS_DEFAULT_PAGE_LIMIT,
    requested: null,
    clamped: false,
  });
});

test('clampRecordsPageLimit passes an in-range limit through unchanged', () => {
  assert.deepEqual(clampRecordsPageLimit('50'), { limit: 50, requested: 50, clamped: false });
  assert.deepEqual(clampRecordsPageLimit(RECORDS_MAX_PAGE_LIMIT), {
    limit: RECORDS_MAX_PAGE_LIMIT,
    requested: RECORDS_MAX_PAGE_LIMIT,
    clamped: false,
  });
});

test('clampRecordsPageLimit clamps an over-max limit and flags it', () => {
  assert.deepEqual(clampRecordsPageLimit('500'), {
    limit: RECORDS_MAX_PAGE_LIMIT,
    requested: 500,
    clamped: true,
  });
});

test('clampRecordsPageLimit falls back to the default for non-positive / unparseable limits without flagging a clamp', () => {
  // A bad limit is not a clamp — there is nothing to honestly report; the
  // default page is the contract.
  assert.deepEqual(clampRecordsPageLimit('0'), {
    limit: RECORDS_DEFAULT_PAGE_LIMIT,
    requested: null,
    clamped: false,
  });
  assert.deepEqual(clampRecordsPageLimit('-5'), {
    limit: RECORDS_DEFAULT_PAGE_LIMIT,
    requested: null,
    clamped: false,
  });
  assert.deepEqual(clampRecordsPageLimit('not-a-number'), {
    limit: RECORDS_DEFAULT_PAGE_LIMIT,
    requested: null,
    clamped: false,
  });
});

// ─── queryRecords: end-to-end envelope coverage ──────────────────────────────

test('limit=500 returns at most 100 records and surfaces a limit_clamped warning', async () => {
  await withSeededDb(150, async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { limit: 500 },
      manifest,
    );
    assert.equal(response.data.length, RECORDS_MAX_PAGE_LIMIT, 'page is clamped to 100 rows');
    assert.equal(response.has_more, true, 'more records remain to page');

    const warning = findLimitClampedWarning(response);
    assert.ok(warning, 'expected a limit_clamped warning in meta.warnings[]');
    assert.equal(warning.param, 'limit');
    assert.deepEqual(warning.detail, {
      requested_limit: 500,
      max_limit: RECORDS_MAX_PAGE_LIMIT,
    });
    assert.match(warning.message, /500/, 'message names the requested limit');
    assert.match(warning.message, /100/, 'message names the effective maximum');
  });
});

test('an in-range limit returns no limit_clamped warning', async () => {
  await withSeededDb(150, async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { limit: 50 },
      manifest,
    );
    assert.equal(response.data.length, 50);
    assert.equal(findLimitClampedWarning(response), null, 'no clamp warning for an in-range limit');
  });
});

test('the default page (no limit) returns at most 25 records and no clamp warning', async () => {
  await withSeededDb(150, async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      {},
      manifest,
    );
    assert.equal(response.data.length, RECORDS_DEFAULT_PAGE_LIMIT);
    assert.equal(findLimitClampedWarning(response), null);
  });
});

test('limit exactly at the maximum (100) is not treated as a clamp', async () => {
  await withSeededDb(150, async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { limit: RECORDS_MAX_PAGE_LIMIT },
      manifest,
    );
    assert.equal(response.data.length, RECORDS_MAX_PAGE_LIMIT);
    assert.equal(findLimitClampedWarning(response), null, 'limit==max is exact, not clamped');
  });
});

// ─── multi-connection fan-in ─────────────────────────────────────────────────

test('multi-connection fan-in surfaces a single deduplicated limit_clamped warning', async () => {
  // Each per-binding query clamps and emits its own limit_clamped warning;
  // appendUniqueWarning must collapse them to one row so a fan-in caller sees
  // exactly one limit_clamped entry (alongside the existing partial_results
  // warning), not one per connection.
  await withDualConnectionDb(80, async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.equal(bindings.length, 2, 'expected two active bindings to fan in');

    const response = await queryRecordsAcrossBindings(
      bindings,
      STREAM,
      grant,
      { limit: 500 },
      manifest,
    );

    const clampWarnings = (response.meta?.warnings ?? []).filter(
      (w) => w.code === CANONICAL_WARNING_CODES.LIMIT_CLAMPED,
    );
    assert.equal(clampWarnings.length, 1, 'fan-in must deduplicate the limit_clamped warning');
    assert.equal(clampWarnings[0].param, 'limit');
    assert.deepEqual(clampWarnings[0].detail, {
      requested_limit: 500,
      max_limit: RECORDS_MAX_PAGE_LIMIT,
    });
  });
});
