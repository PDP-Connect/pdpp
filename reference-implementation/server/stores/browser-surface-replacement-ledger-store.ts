// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  type BindValue,
  execDynamicSqlAcknowledged,
  iterateDynamicSqlAcknowledged,
  transaction,
  writeTransaction,
} from "../../lib/db.ts";
import {
  type ReplacementReceipt,
  ReplacementReplayConflictError,
  selectCurrentReplacementReceipt,
  selectSystemActionableReplacementReceipt,
} from "../../runtime/browser-surface/replacement-receipt-ledger.ts";
import {
  getStorageBackendKind,
  isPostgresStorageBackend,
  postgresQuery,
  withPostgresReadOnlyTransaction,
  withPostgresTransaction,
} from "../postgres-storage.ts";

export interface BrowserSurfaceReplacementReceiptStore {
  append: (receipt: ReplacementReceipt) => Promise<ReplacementReceipt>;
  applySelectionOverride: (input: ReplacementReceiptSelectionOverrideInput) => Promise<void>;
  applySelectionOverrideBatch: (
    input: ReplacementReceiptSelectionOverrideBatchInput
  ) => Promise<ReplacementReceiptSelectionOverrideBatchVerification>;
  dryRunSelectionOverrideBatch: (
    input: ReplacementReceiptSelectionOverrideBatchInput
  ) => Promise<ReplacementReceiptSelectionOverrideBatchVerification>;
  findPendingForScope: (input: {
    readonly connection_id: string;
    readonly surface_subject_id: string | null;
    readonly profile_key: string;
    readonly preferred_surface_id?: string;
  }) => Promise<ReplacementReceipt | null>;
  findPendingForSurface: (surfaceId: string) => Promise<ReplacementReceipt | null>;
  list: () => Promise<readonly ReplacementReceipt[]>;
  listForScope: (input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
  }) => Promise<readonly ReplacementReceipt[]>;
  revokeSelectionOverride: (replacementId: string, revokedAt: string) => Promise<void>;
  revokeSelectionOverrideBatch: (
    authorization: ReplacementSelectionOverrideBatchAuthorization,
    revokedAt: string
  ) => Promise<ReplacementReceiptSelectionOverrideBatchVerification | null>;
  selectCurrent: (input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
    readonly current_generation_hash?: string;
  }) => Promise<ReplacementReceipt | null>;
  selectSystemActionable: (input: {
    readonly connection_id: string;
    readonly profile_key: string;
    readonly surface_subject_id?: string;
  }) => Promise<ReplacementReceipt | null>;
  verifySelectionOverrideBatch: (
    batchId: string
  ) => Promise<ReplacementReceiptSelectionOverrideBatchVerification | null>;
}

/**
 * A reviewed correction must name the immutable receipt it excludes and the
 * earlier failed successor it restores. The store rechecks every field before
 * accepting it; a clock window alone is intentionally not provenance.
 */
export interface ReplacementReceiptSelectionOverrideInput {
  readonly applied_at: string;
  readonly connection_id: string;
  readonly connector_id: string | null;
  readonly idempotency_key: string;
  readonly observed_at: string;
  readonly prior_failed_replacement_id: string;
  readonly profile_key: string;
  readonly replacement_id: string;
  readonly surface_id: string;
  readonly surface_subject_id: string | null;
}

/**
 * A batch correction is deliberately stricter than a collection of ordinary
 * overrides. Its members are reviewed immutable started-receipt fingerprints;
 * the episode bounds are an assertion that the store rechecks, never a
 * time-window selector. The batch may exclude every later start in precisely
 * one scope, or none of them.
 */
export interface ReplacementReceiptSelectionOverrideBatchInput {
  readonly applied_at: string;
  readonly episode: {
    readonly first_event_seq: number;
    readonly first_observed_at: string;
    readonly id: string;
    readonly last_event_seq: number;
    readonly last_observed_at: string;
  };
  readonly members: readonly ReplacementReceiptSelectionOverrideBatchMember[];
  readonly prior_failed_replacement_id: string;
  readonly replacement_batch_id: string;
  readonly reviewed_artifact_sha256: string;
}

export interface ReplacementReceiptSelectionOverrideBatchMember {
  readonly connection_id: string;
  readonly connector_id: string | null;
  readonly event_seq: number;
  readonly idempotency_key: string;
  readonly observed_at: string;
  readonly profile_key: string;
  readonly replacement_id: string;
  readonly scope: string;
  readonly surface_id: string;
  readonly surface_subject_id: string | null;
}

export interface ReplacementReceiptSelectionOverrideBatchVerification {
  readonly active: boolean;
  readonly audit_outbox_id: string;
  readonly episode_id: string;
  readonly member_replacement_ids: readonly string[];
  readonly replacement_batch_id: string;
  readonly reviewed_artifact_sha256: string;
}

/** The only artifact facts needed to authorize an already-admitted revoke. */
export interface ReplacementSelectionOverrideBatchAuthorization {
  readonly episode_id: string;
  readonly replacement_batch_id: string;
  readonly reviewed_artifact_sha256: string;
}

const ARTIFACT_SHA256_REGEX = /^[a-f0-9]{64}$/;

interface ReplacementReceiptRow {
  cause: ReplacementReceipt["cause"];
  connection_id: string;
  connector_id: string | null;
  event_seq: number | string;
  idempotency_key: string;
  lease_id: string | null;
  next_generation_hash: string | null;
  observed_at: string;
  phase: ReplacementReceipt["phase"];
  previous_generation_hash: string | null;
  profile_key: string;
  replacement_id: string;
  reviewed_artifact_sha256?: string;
  run_id: string | null;
  scope: string;
  surface_id: string | null;
  surface_subject_id: string | null;
  terminal_outcome: ReplacementReceipt["terminal_outcome"] | null;
}

export const SQLITE_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS browser_surface_replacement_receipts (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  replacement_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  run_id TEXT,
  lease_id TEXT,
  surface_id TEXT,
  previous_generation_hash TEXT,
  next_generation_hash TEXT,
  cause TEXT NOT NULL CHECK (cause IN (
    'capacity_pressure',
    'idle_ttl',
    'operator_requested',
    'restart_reconcile',
    'readiness_invalidated',
    'allocator_internal_ensure_surface',
    'same_container_browser_generation_change',
    'external_or_host_loss'
  )),
  phase TEXT NOT NULL CHECK (phase IN ('started', 'completed', 'terminal')),
  terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('failed', 'abandoned')),
  observed_at TEXT NOT NULL,
  UNIQUE (idempotency_key, phase),
  UNIQUE (replacement_id, phase),
  CHECK ((phase = 'terminal') = (terminal_outcome IS NOT NULL)),
  CHECK (phase != 'completed' OR next_generation_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_browser_surface_replacement_scope_order
  ON browser_surface_replacement_receipts(connection_id, surface_subject_id, event_seq, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_browser_surface_replacement_surface_order
  ON browser_surface_replacement_receipts(surface_id, event_seq, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_surface_replacement_one_resolution
  ON browser_surface_replacement_receipts(replacement_id)
  WHERE phase IN ('completed', 'terminal');
CREATE TABLE IF NOT EXISTS browser_surface_replacement_selection_overrides (
  replacement_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  surface_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  prior_failed_replacement_id TEXT NOT NULL,
  replacement_batch_id TEXT,
  applied_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_browser_surface_replacement_selection_override_batch
  ON browser_surface_replacement_selection_overrides(replacement_batch_id);
CREATE TABLE IF NOT EXISTS browser_surface_replacement_selection_override_batches (
  replacement_batch_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  prior_failed_replacement_id TEXT NOT NULL,
  reviewed_artifact_sha256 TEXT NOT NULL,
  first_event_seq INTEGER NOT NULL,
  last_event_seq INTEGER NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS browser_surface_replacement_selection_override_audit_outbox (
  audit_outbox_id TEXT PRIMARY KEY,
  replacement_batch_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('apply', 'revoke')),
  reviewed_artifact_sha256 TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE(replacement_batch_id, operation)
);
`;

export const POSTGRES_BROWSER_SURFACE_REPLACEMENT_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS browser_surface_replacement_receipts (
  event_seq BIGSERIAL PRIMARY KEY,
  replacement_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  run_id TEXT,
  lease_id TEXT,
  surface_id TEXT,
  previous_generation_hash TEXT,
  next_generation_hash TEXT,
  cause TEXT NOT NULL CHECK (cause IN (
    'capacity_pressure',
    'idle_ttl',
    'operator_requested',
    'restart_reconcile',
    'readiness_invalidated',
    'allocator_internal_ensure_surface',
    'same_container_browser_generation_change',
    'external_or_host_loss'
  )),
  phase TEXT NOT NULL CHECK (phase IN ('started', 'completed', 'terminal')),
  terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('failed', 'abandoned')),
  observed_at TEXT NOT NULL,
  UNIQUE (idempotency_key, phase),
  UNIQUE (replacement_id, phase),
  CHECK ((phase = 'terminal') = (terminal_outcome IS NOT NULL)),
  CHECK (phase != 'completed' OR next_generation_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_pg_browser_surface_replacement_scope_order
  ON browser_surface_replacement_receipts(connection_id, surface_subject_id, event_seq, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_pg_browser_surface_replacement_surface_order
  ON browser_surface_replacement_receipts(surface_id, event_seq, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_browser_surface_replacement_one_resolution
  ON browser_surface_replacement_receipts(replacement_id)
  WHERE phase IN ('completed', 'terminal');
CREATE TABLE IF NOT EXISTS browser_surface_replacement_selection_overrides (
  replacement_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  surface_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  prior_failed_replacement_id TEXT NOT NULL,
  replacement_batch_id TEXT,
  applied_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pg_browser_surface_replacement_selection_override_batch
  ON browser_surface_replacement_selection_overrides(replacement_batch_id);
CREATE TABLE IF NOT EXISTS browser_surface_replacement_selection_override_batches (
  replacement_batch_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connector_id TEXT,
  profile_key TEXT NOT NULL,
  surface_subject_id TEXT,
  prior_failed_replacement_id TEXT NOT NULL,
  reviewed_artifact_sha256 TEXT NOT NULL,
  first_event_seq BIGINT NOT NULL,
  last_event_seq BIGINT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS browser_surface_replacement_selection_override_audit_outbox (
  audit_outbox_id TEXT PRIMARY KEY,
  replacement_batch_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('apply', 'revoke')),
  reviewed_artifact_sha256 TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE(replacement_batch_id, operation)
);
`;

function mapRow(row: ReplacementReceiptRow): ReplacementReceipt {
  const receipt = {
    cause: row.cause,
    connection_id: row.connection_id,
    event_seq: Number(row.event_seq),
    idempotency_key: row.idempotency_key,
    observed_at: row.observed_at,
    phase: row.phase,
    profile_key: row.profile_key,
    replacement_id: row.replacement_id,
    scope: row.scope,
  } as ReplacementReceipt;
  setOptionalRowValue(receipt, "connector_id", row.connector_id);
  setOptionalRowValue(receipt, "surface_subject_id", row.surface_subject_id);
  setOptionalRowValue(receipt, "run_id", row.run_id);
  setOptionalRowValue(receipt, "lease_id", row.lease_id);
  setOptionalRowValue(receipt, "surface_id", row.surface_id);
  setOptionalRowValue(receipt, "previous_generation_hash", row.previous_generation_hash);
  setOptionalRowValue(receipt, "next_generation_hash", row.next_generation_hash);
  setOptionalRowValue(receipt, "terminal_outcome", row.terminal_outcome);
  return receipt;
}

function assertSameEvent(existing: ReplacementReceipt, incoming: ReplacementReceipt): void {
  const immutableFields: readonly (keyof ReplacementReceipt)[] = [
    "replacement_id",
    "idempotency_key",
    "scope",
    "connection_id",
    "connector_id",
    "profile_key",
    "surface_subject_id",
    "run_id",
    "lease_id",
    "surface_id",
    "previous_generation_hash",
    "next_generation_hash",
    "cause",
    "phase",
    "terminal_outcome",
  ];
  for (const field of immutableFields) {
    assertSameEventField(existing, incoming, field);
  }
}

function assertSameEventField(
  existing: ReplacementReceipt,
  incoming: ReplacementReceipt,
  field: keyof ReplacementReceipt
): void {
  if (existing[field] !== incoming[field]) {
    throw new ReplacementReplayConflictError(`replacement replay changed immutable field ${field}`);
  }
}

function params(receipt: ReplacementReceipt): readonly (string | number | null)[] {
  return [
    receipt.replacement_id,
    receipt.idempotency_key,
    receipt.scope,
    receipt.connection_id,
    nullable(receipt.connector_id),
    receipt.profile_key,
    nullable(receipt.surface_subject_id),
    nullable(receipt.run_id),
    nullable(receipt.lease_id),
    nullable(receipt.surface_id),
    nullable(receipt.previous_generation_hash),
    nullable(receipt.next_generation_hash),
    receipt.cause,
    receipt.phase,
    nullable(receipt.terminal_outcome),
    receipt.observed_at,
  ];
}

function nullable(value: string | undefined): string | null {
  return value ?? null;
}

interface SelectionOverrideRow {
  readonly applied_at: string;
  readonly connection_id: string;
  readonly connector_id: string | null;
  readonly idempotency_key: string;
  readonly observed_at: string;
  readonly prior_failed_replacement_id: string;
  readonly profile_key: string;
  readonly replacement_batch_id?: string | null;
  readonly replacement_id: string;
  readonly revoked_at: string | null;
  readonly surface_id: string;
  readonly surface_subject_id: string | null;
}

interface SelectionOverrideBatchRow {
  readonly applied_at: string;
  readonly connection_id: string;
  readonly connector_id: string | null;
  readonly episode_id: string;
  readonly first_event_seq: number | string;
  readonly first_observed_at: string;
  readonly last_event_seq: number | string;
  readonly last_observed_at: string;
  readonly prior_failed_replacement_id: string;
  readonly profile_key: string;
  readonly replacement_batch_id: string;
  readonly reviewed_artifact_sha256: string;
  readonly revoked_at: string | null;
  readonly surface_subject_id: string | null;
}

interface ReplacementBatchScope {
  readonly connection_id: string;
  readonly connector_id: string | null;
  readonly profile_key: string;
  readonly surface_subject_id: string | null;
}

interface ReplacementBatchLedgerRows {
  readonly later_starts: readonly ReplacementReceiptRow[];
  readonly prior_started: ReplacementReceiptRow;
  readonly prior_terminal: ReplacementReceiptRow;
  readonly resolved_later_replacement_ids: readonly string[];
}

type PostgresLedgerQuery = (sql: string, values?: readonly unknown[]) => Promise<{ rows: ReplacementReceiptRow[] }>;

function overrideParams(input: ReplacementReceiptSelectionOverrideInput): readonly (string | null)[] {
  return [
    input.replacement_id,
    input.idempotency_key,
    input.connection_id,
    input.connector_id,
    input.profile_key,
    input.surface_subject_id,
    input.surface_id,
    input.observed_at,
    input.prior_failed_replacement_id,
    input.applied_at,
  ];
}

function assertOverrideReplay(row: SelectionOverrideRow, input: ReplacementReceiptSelectionOverrideInput): void {
  const expected: Omit<SelectionOverrideRow, "revoked_at"> = {
    applied_at: input.applied_at,
    connection_id: input.connection_id,
    connector_id: input.connector_id,
    idempotency_key: input.idempotency_key,
    observed_at: input.observed_at,
    prior_failed_replacement_id: input.prior_failed_replacement_id,
    profile_key: input.profile_key,
    replacement_id: input.replacement_id,
    surface_id: input.surface_id,
    surface_subject_id: input.surface_subject_id,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (row[key] !== expected[key]) {
      throw new ReplacementReplayConflictError(`selection override changed immutable field ${key}`);
    }
  }
}

function selectionOverrideError(message: string): Error {
  return Object.assign(new Error(`selection override requires batch ${message}`), { code: "invalid_request" });
}

function batchScope(input: ReplacementReceiptSelectionOverrideBatchInput): ReplacementBatchScope {
  const [first] = input.members;
  if (!first) {
    throw selectionOverrideError("at least one reviewed receipt fingerprint");
  }
  return {
    connection_id: first.connection_id,
    connector_id: first.connector_id,
    profile_key: first.profile_key,
    surface_subject_id: first.surface_subject_id,
  };
}

function assertExactBatchInput(input: ReplacementReceiptSelectionOverrideBatchInput): ReplacementBatchScope {
  if (
    !(
      input.replacement_batch_id &&
      input.episode.id &&
      input.prior_failed_replacement_id &&
      input.applied_at &&
      ARTIFACT_SHA256_REGEX.test(input.reviewed_artifact_sha256)
    )
  ) {
    throw selectionOverrideError("a batch id, episode id, predecessor, applied_at, and artifact digest");
  }
  const scope = batchScope(input);
  const memberIds = new Set<string>();
  for (const member of input.members) {
    if (
      !(
        member.replacement_id &&
        member.idempotency_key &&
        member.scope &&
        member.surface_id &&
        member.observed_at &&
        Number.isSafeInteger(member.event_seq)
      ) ||
      member.event_seq < 1
    ) {
      throw selectionOverrideError("complete immutable receipt fingerprints");
    }
    if (memberIds.has(member.replacement_id)) {
      throw selectionOverrideError("unique reviewed receipt fingerprints");
    }
    memberIds.add(member.replacement_id);
    if (
      member.connection_id !== scope.connection_id ||
      member.connector_id !== scope.connector_id ||
      member.profile_key !== scope.profile_key ||
      member.surface_subject_id !== scope.surface_subject_id
    ) {
      throw selectionOverrideError("one exact connection, connector, subject, and profile scope");
    }
  }
  const { first_event_seq, first_observed_at, last_event_seq, last_observed_at } = input.episode;
  if (
    !(Number.isSafeInteger(first_event_seq) && Number.isSafeInteger(last_event_seq)) ||
    first_event_seq < 1 ||
    last_event_seq < first_event_seq ||
    !first_observed_at ||
    !last_observed_at ||
    first_observed_at > last_observed_at
  ) {
    throw selectionOverrideError("ordered explicit episode event and observation bounds");
  }
  return scope;
}

function receiptMatchesBatchMember(
  row: ReplacementReceiptRow,
  member: ReplacementReceiptSelectionOverrideBatchMember
): boolean {
  return (
    row.replacement_id === member.replacement_id &&
    row.idempotency_key === member.idempotency_key &&
    row.scope === member.scope &&
    row.connection_id === member.connection_id &&
    row.connector_id === member.connector_id &&
    row.profile_key === member.profile_key &&
    row.surface_subject_id === member.surface_subject_id &&
    row.surface_id === member.surface_id &&
    row.observed_at === member.observed_at &&
    Number(row.event_seq) === member.event_seq &&
    row.cause === "external_or_host_loss" &&
    row.phase === "started"
  );
}

function assertExactBatchLedger(
  input: ReplacementReceiptSelectionOverrideBatchInput,
  rows: ReplacementBatchLedgerRows
): ReplacementBatchScope {
  const scope = assertExactBatchInput(input);
  if (
    rows.prior_terminal.replacement_id !== input.prior_failed_replacement_id ||
    rows.prior_terminal.cause !== "external_or_host_loss" ||
    rows.prior_terminal.phase !== "terminal" ||
    rows.prior_terminal.terminal_outcome !== "failed" ||
    rows.prior_started.replacement_id !== input.prior_failed_replacement_id ||
    rows.prior_started.phase !== "started" ||
    Number(rows.prior_started.event_seq) >= Number(rows.prior_terminal.event_seq)
  ) {
    throw selectionOverrideError("a prior failed external-loss predecessor and its started receipt");
  }
  for (const row of [rows.prior_started, rows.prior_terminal]) {
    if (
      row.connection_id !== scope.connection_id ||
      row.connector_id !== scope.connector_id ||
      row.profile_key !== scope.profile_key ||
      row.surface_subject_id !== scope.surface_subject_id
    ) {
      throw selectionOverrideError("a predecessor in the exact reviewed scope");
    }
  }
  const expected = new Map(input.members.map((member) => [member.replacement_id, member]));
  if (rows.resolved_later_replacement_ids.length > 0) {
    throw selectionOverrideError("every reviewed member remains unresolved");
  }
  if (rows.later_starts.length !== expected.size) {
    throw selectionOverrideError("the complete set of later starts in the reviewed scope");
  }
  for (const row of rows.later_starts) {
    const member = expected.get(row.replacement_id);
    if (!(member && receiptMatchesBatchMember(row, member))) {
      throw selectionOverrideError("no unrelated, altered, resolved, or omitted intervening start");
    }
  }
  const eventSeqs = rows.later_starts.map((row) => Number(row.event_seq));
  const observedAts = rows.later_starts.map((row) => row.observed_at);
  const firstObservedAt = observedAts.reduce((first, observedAt) => (observedAt < first ? observedAt : first));
  const lastObservedAt = observedAts.reduce((last, observedAt) => (observedAt > last ? observedAt : last));
  if (
    Math.min(...eventSeqs) !== input.episode.first_event_seq ||
    Math.max(...eventSeqs) !== input.episode.last_event_seq ||
    firstObservedAt !== input.episode.first_observed_at ||
    lastObservedAt !== input.episode.last_observed_at
  ) {
    throw selectionOverrideError("episode bounds equal to the reviewed immutable receipts");
  }
  return scope;
}

function assertBatchReplay(
  row: SelectionOverrideBatchRow,
  input: ReplacementReceiptSelectionOverrideBatchInput,
  scope: ReplacementBatchScope
): void {
  const expected: Omit<SelectionOverrideBatchRow, "revoked_at"> = {
    applied_at: input.applied_at,
    connection_id: scope.connection_id,
    connector_id: scope.connector_id,
    episode_id: input.episode.id,
    first_event_seq: input.episode.first_event_seq,
    first_observed_at: input.episode.first_observed_at,
    last_event_seq: input.episode.last_event_seq,
    last_observed_at: input.episode.last_observed_at,
    prior_failed_replacement_id: input.prior_failed_replacement_id,
    profile_key: scope.profile_key,
    replacement_batch_id: input.replacement_batch_id,
    reviewed_artifact_sha256: input.reviewed_artifact_sha256,
    surface_subject_id: scope.surface_subject_id,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    const actual = row[key];
    const expectedValue = expected[key];
    const equal =
      (key === "first_event_seq" || key === "last_event_seq") &&
      typeof expectedValue === "number" &&
      (typeof actual === "number" || typeof actual === "string")
        ? Number(actual) === expectedValue
        : actual === expectedValue;
    if (!equal) {
      throw new ReplacementReplayConflictError(`selection override batch changed immutable field ${key}`);
    }
  }
}

function assertPersistedBatchSnapshot(
  batch: SelectionOverrideBatchRow,
  input: ReplacementReceiptSelectionOverrideBatchInput
): ReplacementBatchScope {
  const scope = assertExactBatchInput(input);
  assertBatchReplay(batch, input, scope);
  const eventSeqs = input.members.map((member) => member.event_seq);
  const observedAts = input.members.map((member) => member.observed_at);
  if (
    Math.min(...eventSeqs) !== input.episode.first_event_seq ||
    Math.max(...eventSeqs) !== input.episode.last_event_seq ||
    observedAts.reduce((first, value) => (value < first ? value : first)) !== input.episode.first_observed_at ||
    observedAts.reduce((last, value) => (value > last ? value : last)) !== input.episode.last_observed_at
  ) {
    throw selectionOverrideError("persisted episode bounds equal to the original reviewed receipts");
  }
  return scope;
}

function batchVerification(
  row: SelectionOverrideBatchRow,
  members: readonly SelectionOverrideRow[],
  operation: "apply" | "revoke"
): ReplacementReceiptSelectionOverrideBatchVerification {
  return {
    active: row.revoked_at === null,
    audit_outbox_id: `${row.replacement_batch_id}:${operation}`,
    episode_id: row.episode_id,
    member_replacement_ids: members.map((member) => member.replacement_id).sort(),
    replacement_batch_id: row.replacement_batch_id,
    reviewed_artifact_sha256: row.reviewed_artifact_sha256,
  };
}

function batchMemberOverrideInput(
  input: ReplacementReceiptSelectionOverrideBatchInput,
  member: ReplacementReceiptSelectionOverrideBatchMember
): ReplacementReceiptSelectionOverrideInput {
  return {
    applied_at: input.applied_at,
    connection_id: member.connection_id,
    connector_id: member.connector_id,
    idempotency_key: member.idempotency_key,
    observed_at: member.observed_at,
    prior_failed_replacement_id: input.prior_failed_replacement_id,
    profile_key: member.profile_key,
    replacement_id: member.replacement_id,
    surface_id: member.surface_id,
    surface_subject_id: member.surface_subject_id,
  };
}

function auditOutboxId(batchId: string, operation: "apply" | "revoke"): string {
  return `${batchId}:${operation}`;
}

function assertBatchAuthorization(
  authorization: ReplacementSelectionOverrideBatchAuthorization
): ReplacementSelectionOverrideBatchAuthorization {
  if (
    !authorization ||
    typeof authorization.replacement_batch_id !== "string" ||
    !authorization.replacement_batch_id ||
    typeof authorization.episode_id !== "string" ||
    !authorization.episode_id ||
    typeof authorization.reviewed_artifact_sha256 !== "string" ||
    !ARTIFACT_SHA256_REGEX.test(authorization.reviewed_artifact_sha256)
  ) {
    throw selectionOverrideError("a reviewed batch id, episode id, and SHA-256 artifact digest before revoke");
  }
  return authorization;
}

function spineAuditEventId(batchId: string, operation: "apply" | "revoke"): string {
  return `browser-surface-replacement-selection-override:${auditOutboxId(batchId, operation)}`;
}

function sqliteInsertBatchAudit(
  input: Pick<ReplacementReceiptSelectionOverrideBatchInput, "replacement_batch_id" | "reviewed_artifact_sha256">,
  operation: "apply" | "revoke",
  snapshot: ReplacementReceiptSelectionOverrideBatchVerification,
  createdAt: string
): void {
  const eventId = spineAuditEventId(input.replacement_batch_id, operation);
  execDynamicSqlAcknowledged(
    `INSERT OR IGNORE INTO spine_events(
      event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
      actor_type, actor_id, subject_type, subject_id, object_type, object_id, status, data_json, version
    ) VALUES (?, (SELECT COALESCE(MAX(event_seq), 0) + 1 FROM spine_events), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      `maintenance.browser_surface_replacement_selection_override.${operation}`,
      createdAt,
      createdAt,
      input.replacement_batch_id,
      eventId,
      "maintenance",
      "reviewed_artifact",
      "replacement_selection_override_batch",
      input.replacement_batch_id,
      "replacement_selection_override_batch",
      input.replacement_batch_id,
      operation,
      JSON.stringify({ audit_outbox_id: auditOutboxId(input.replacement_batch_id, operation), snapshot }),
      "1",
    ]
  );
  execDynamicSqlAcknowledged(
    `INSERT INTO browser_surface_replacement_selection_override_audit_outbox(
      audit_outbox_id, replacement_batch_id, operation, reviewed_artifact_sha256, snapshot_json, created_at, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      auditOutboxId(input.replacement_batch_id, operation),
      input.replacement_batch_id,
      operation,
      input.reviewed_artifact_sha256,
      JSON.stringify(snapshot),
      createdAt,
      createdAt,
    ]
  );
}

async function postgresInsertBatchAudit(
  query: PostgresLedgerQuery,
  input: Pick<ReplacementReceiptSelectionOverrideBatchInput, "replacement_batch_id" | "reviewed_artifact_sha256">,
  operation: "apply" | "revoke",
  snapshot: ReplacementReceiptSelectionOverrideBatchVerification,
  createdAt: string
): Promise<void> {
  const eventId = spineAuditEventId(input.replacement_batch_id, operation);
  await query(
    `INSERT INTO spine_events(
      event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
      actor_type, actor_id, subject_type, subject_id, object_type, object_id, status, data_json, version
    ) VALUES ($1, $2, $3, $3, $4, $1, $5, $6, $7, $4, $7, $4, $8, $9::jsonb, $10)
    ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      `maintenance.browser_surface_replacement_selection_override.${operation}`,
      createdAt,
      input.replacement_batch_id,
      "maintenance",
      "reviewed_artifact",
      "replacement_selection_override_batch",
      operation,
      JSON.stringify({ audit_outbox_id: auditOutboxId(input.replacement_batch_id, operation), snapshot }),
      "1",
    ]
  );
  await query(
    `INSERT INTO browser_surface_replacement_selection_override_audit_outbox(
      audit_outbox_id, replacement_batch_id, operation, reviewed_artifact_sha256, snapshot_json, created_at, delivered_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      auditOutboxId(input.replacement_batch_id, operation),
      input.replacement_batch_id,
      operation,
      input.reviewed_artifact_sha256,
      JSON.stringify(snapshot),
      createdAt,
    ]
  );
}

function sqliteBatchLedgerRows(input: ReplacementReceiptSelectionOverrideBatchInput): ReplacementBatchLedgerRows {
  const scope = assertExactBatchInput(input);
  const priorTerminal = dbRow(
    "SELECT * FROM browser_surface_replacement_receipts WHERE replacement_id = ? AND phase = 'terminal'",
    [input.prior_failed_replacement_id]
  ) as ReplacementReceiptRow | undefined;
  const priorStarted = dbRow(
    "SELECT * FROM browser_surface_replacement_receipts WHERE replacement_id = ? AND phase = 'started'",
    [input.prior_failed_replacement_id]
  ) as ReplacementReceiptRow | undefined;
  if (!(priorTerminal && priorStarted)) {
    throw selectionOverrideError("a prior failed external-loss predecessor and its started receipt");
  }
  const laterStarts = dbRows(
    `SELECT * FROM browser_surface_replacement_receipts
     WHERE connection_id = ?
       AND connector_id IS ?
       AND profile_key = ?
       AND surface_subject_id IS ?
       AND phase = 'started'
       AND event_seq > ?
     ORDER BY event_seq`,
    [scope.connection_id, scope.connector_id, scope.profile_key, scope.surface_subject_id, priorStarted.event_seq]
  ) as ReplacementReceiptRow[];
  const resolvedLaterReplacementIds = dbRows(
    `SELECT started.replacement_id FROM browser_surface_replacement_receipts AS started
     WHERE started.connection_id = ?
       AND started.connector_id IS ?
       AND started.profile_key = ?
       AND started.surface_subject_id IS ?
       AND started.phase = 'started'
       AND started.event_seq > ?
       AND EXISTS (
         SELECT 1 FROM browser_surface_replacement_receipts AS resolved
         WHERE resolved.replacement_id = started.replacement_id
           AND resolved.phase IN ('completed', 'terminal')
       )`,
    [scope.connection_id, scope.connector_id, scope.profile_key, scope.surface_subject_id, priorStarted.event_seq]
  ).map((row) => row.replacement_id);
  return {
    later_starts: laterStarts,
    prior_started: priorStarted,
    prior_terminal: priorTerminal,
    resolved_later_replacement_ids: resolvedLaterReplacementIds,
  };
}

async function postgresBatchLedgerRows(
  query: PostgresLedgerQuery,
  input: ReplacementReceiptSelectionOverrideBatchInput
): Promise<ReplacementBatchLedgerRows> {
  const scope = assertExactBatchInput(input);
  const prior = await query(
    `SELECT * FROM browser_surface_replacement_receipts
     WHERE replacement_id = $1 AND phase IN ('started', 'terminal')
     ORDER BY event_seq`,
    [input.prior_failed_replacement_id]
  );
  const priorStarted = prior.rows.find((row) => row.phase === "started");
  const priorTerminal = prior.rows.find((row) => row.phase === "terminal");
  if (!(priorTerminal && priorStarted)) {
    throw selectionOverrideError("a prior failed external-loss predecessor and its started receipt");
  }
  const later = await query(
    `SELECT * FROM browser_surface_replacement_receipts
     WHERE connection_id = $1
       AND connector_id IS NOT DISTINCT FROM $2
       AND profile_key = $3
       AND surface_subject_id IS NOT DISTINCT FROM $4
       AND phase = 'started'
       AND event_seq > $5
     ORDER BY event_seq`,
    [scope.connection_id, scope.connector_id, scope.profile_key, scope.surface_subject_id, priorStarted.event_seq]
  );
  const resolvedLater = await query(
    `SELECT started.replacement_id FROM browser_surface_replacement_receipts AS started
     WHERE started.connection_id = $1
       AND started.connector_id IS NOT DISTINCT FROM $2
       AND started.profile_key = $3
       AND started.surface_subject_id IS NOT DISTINCT FROM $4
       AND started.phase = 'started'
       AND started.event_seq > $5
       AND EXISTS (
         SELECT 1 FROM browser_surface_replacement_receipts AS resolved
         WHERE resolved.replacement_id = started.replacement_id
           AND resolved.phase IN ('completed', 'terminal')
       )`,
    [scope.connection_id, scope.connector_id, scope.profile_key, scope.surface_subject_id, priorStarted.event_seq]
  );
  return {
    later_starts: later.rows,
    prior_started: priorStarted,
    prior_terminal: priorTerminal,
    resolved_later_replacement_ids: resolvedLater.rows.map((row) => row.replacement_id),
  };
}

function batchInsertParams(
  input: ReplacementReceiptSelectionOverrideBatchInput,
  scope: ReplacementBatchScope
): readonly (string | number | null)[] {
  return [
    input.replacement_batch_id,
    input.episode.id,
    scope.connection_id,
    scope.connector_id,
    scope.profile_key,
    scope.surface_subject_id,
    input.prior_failed_replacement_id,
    input.reviewed_artifact_sha256,
    input.episode.first_event_seq,
    input.episode.last_event_seq,
    input.episode.first_observed_at,
    input.episode.last_observed_at,
    input.applied_at,
  ];
}

function sqliteInsertBatch(input: ReplacementReceiptSelectionOverrideBatchInput, scope: ReplacementBatchScope): void {
  // REVIEWED-DYNAMIC: the ledger schema is initialized by the runtime and is intentionally shared by SQLite tests.
  execDynamicSqlAcknowledged(
    `INSERT INTO browser_surface_replacement_selection_override_batches(
      replacement_batch_id, episode_id, connection_id, connector_id, profile_key, surface_subject_id,
      prior_failed_replacement_id, reviewed_artifact_sha256, first_event_seq, last_event_seq, first_observed_at, last_observed_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    batchInsertParams(input, scope) as BindValue[]
  );
  for (const member of input.members) {
    const override = batchMemberOverrideInput(input, member);
    // REVIEWED-DYNAMIC: the ledger schema is initialized by the runtime and is intentionally shared by SQLite tests.
    execDynamicSqlAcknowledged(
      `INSERT INTO browser_surface_replacement_selection_overrides(
        replacement_id, idempotency_key, connection_id, connector_id, profile_key,
        surface_subject_id, surface_id, observed_at, prior_failed_replacement_id, replacement_batch_id, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...overrideParams(override).slice(0, -1), input.replacement_batch_id, input.applied_at] as BindValue[]
    );
  }
}

async function postgresInsertBatch(
  query: PostgresLedgerQuery,
  input: ReplacementReceiptSelectionOverrideBatchInput,
  scope: ReplacementBatchScope
): Promise<void> {
  await query(
    `INSERT INTO browser_surface_replacement_selection_override_batches(
      replacement_batch_id, episode_id, connection_id, connector_id, profile_key, surface_subject_id,
      prior_failed_replacement_id, reviewed_artifact_sha256, first_event_seq, last_event_seq, first_observed_at, last_observed_at, applied_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    batchInsertParams(input, scope)
  );
  for (const member of input.members) {
    const override = batchMemberOverrideInput(input, member);
    // biome-ignore lint/performance/noAwaitInLoops: ordered statements share one transaction and must fail as one unit.
    await query(
      `INSERT INTO browser_surface_replacement_selection_overrides(
        replacement_id, idempotency_key, connection_id, connector_id, profile_key,
        surface_subject_id, surface_id, observed_at, prior_failed_replacement_id, replacement_batch_id, applied_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [...overrideParams(override).slice(0, -1), input.replacement_batch_id, input.applied_at]
    );
  }
}

function assertOverrideTarget(row: ReplacementReceiptRow | undefined): void {
  if (!row) {
    throw new Error("selection override requires an unresolved external-loss receipt and its earlier failed successor");
  }
}

function sqliteOverrideTarget(input: ReplacementReceiptSelectionOverrideInput): ReplacementReceiptRow | undefined {
  return dbRow(
    `SELECT started.* FROM browser_surface_replacement_receipts AS started
     JOIN browser_surface_replacement_receipts AS prior
       ON prior.replacement_id = ?
      AND prior.phase = 'terminal'
      AND prior.cause = 'external_or_host_loss'
      AND prior.terminal_outcome = 'failed'
      AND prior.connection_id = started.connection_id
      AND prior.profile_key = started.profile_key
      AND prior.surface_subject_id IS started.surface_subject_id
      AND prior.event_seq < started.event_seq
     JOIN browser_surface_replacement_receipts AS prior_started
       ON prior_started.replacement_id = prior.replacement_id
      AND prior_started.phase = 'started'
      AND prior_started.event_seq < started.event_seq
     WHERE started.replacement_id = ?
       AND started.idempotency_key = ?
       AND started.connection_id = ?
       AND started.connector_id IS ?
       AND started.profile_key = ?
       AND started.surface_subject_id IS ?
       AND started.surface_id = ?
       AND started.observed_at = ?
       AND started.cause = 'external_or_host_loss'
       AND started.phase = 'started'
       AND NOT EXISTS (
         SELECT 1 FROM browser_surface_replacement_receipts AS resolved
         WHERE resolved.replacement_id = started.replacement_id
           AND resolved.phase IN ('completed', 'terminal')
       )
       AND NOT EXISTS (
         SELECT 1 FROM browser_surface_replacement_receipts AS later_started
         WHERE later_started.connection_id = started.connection_id
           AND later_started.profile_key = started.profile_key
           AND later_started.surface_subject_id IS started.surface_subject_id
           AND later_started.phase = 'started'
           AND later_started.replacement_id != started.replacement_id
           AND later_started.event_seq > prior_started.event_seq
       )`,
    [
      input.prior_failed_replacement_id,
      input.replacement_id,
      input.idempotency_key,
      input.connection_id,
      input.connector_id,
      input.profile_key,
      input.surface_subject_id,
      input.surface_id,
      input.observed_at,
    ]
  );
}

async function postgresOverrideTarget(
  query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: ReplacementReceiptRow[] }>,
  input: ReplacementReceiptSelectionOverrideInput
): Promise<ReplacementReceiptRow | undefined> {
  const result = await query(
    `SELECT started.* FROM browser_surface_replacement_receipts AS started
     JOIN browser_surface_replacement_receipts AS prior
       ON prior.replacement_id = $1
      AND prior.phase = 'terminal'
      AND prior.cause = 'external_or_host_loss'
      AND prior.terminal_outcome = 'failed'
      AND prior.connection_id = started.connection_id
      AND prior.profile_key = started.profile_key
      AND prior.surface_subject_id IS NOT DISTINCT FROM started.surface_subject_id
      AND prior.event_seq < started.event_seq
     JOIN browser_surface_replacement_receipts AS prior_started
       ON prior_started.replacement_id = prior.replacement_id
      AND prior_started.phase = 'started'
      AND prior_started.event_seq < started.event_seq
     WHERE started.replacement_id = $2
       AND started.idempotency_key = $3
       AND started.connection_id = $4
       AND started.connector_id IS NOT DISTINCT FROM $5
       AND started.profile_key = $6
       AND started.surface_subject_id IS NOT DISTINCT FROM $7
       AND started.surface_id = $8
       AND started.observed_at = $9
       AND started.cause = 'external_or_host_loss'
       AND started.phase = 'started'
       AND NOT EXISTS (
         SELECT 1 FROM browser_surface_replacement_receipts AS resolved
         WHERE resolved.replacement_id = started.replacement_id
           AND resolved.phase IN ('completed', 'terminal')
       )
       AND NOT EXISTS (
         SELECT 1 FROM browser_surface_replacement_receipts AS later_started
         WHERE later_started.connection_id = started.connection_id
           AND later_started.profile_key = started.profile_key
           AND later_started.surface_subject_id IS NOT DISTINCT FROM started.surface_subject_id
           AND later_started.phase = 'started'
           AND later_started.replacement_id <> started.replacement_id
           AND later_started.event_seq > prior_started.event_seq
       )`,
    [
      input.prior_failed_replacement_id,
      input.replacement_id,
      input.idempotency_key,
      input.connection_id,
      input.connector_id,
      input.profile_key,
      input.surface_subject_id,
      input.surface_id,
      input.observed_at,
    ]
  );
  return result.rows[0];
}

function sqliteActiveOverrideIds(): ReadonlySet<string> {
  return new Set(
    dbRows("SELECT replacement_id FROM browser_surface_replacement_selection_overrides WHERE revoked_at IS NULL").map(
      (row) => row.replacement_id
    )
  );
}

async function postgresActiveOverrideIds(
  query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: ReplacementReceiptRow[] }>
): Promise<ReadonlySet<string>> {
  const result = await query(
    "SELECT replacement_id FROM browser_surface_replacement_selection_overrides WHERE revoked_at IS NULL"
  );
  return new Set(result.rows.map((row) => row.replacement_id));
}

function setOptionalRowValue(
  target: ReplacementReceipt,
  field: keyof ReplacementReceipt,
  value: string | null | undefined
): void {
  if (value !== null && value !== undefined) {
    (target as unknown as Record<string, unknown>)[field] = value;
  }
}

class SqliteBrowserSurfaceReplacementReceiptStore implements BrowserSurfaceReplacementReceiptStore {
  async applySelectionOverrideBatch(
    input: ReplacementReceiptSelectionOverrideBatchInput
  ): Promise<ReplacementReceiptSelectionOverrideBatchVerification> {
    return await Promise.resolve(
      writeTransaction(
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SQLite's one transaction deliberately keeps exact replay, admission, atomic writes, and durable audit fact visible together.
        () => {
          const inputScope = assertExactBatchInput(input);
          const existing = dbRow(
            "SELECT * FROM browser_surface_replacement_selection_override_batches WHERE replacement_batch_id = ?",
            [input.replacement_batch_id]
          ) as SelectionOverrideBatchRow | undefined;
          if (existing) {
            assertBatchReplay(existing, input, inputScope);
            const members = dbRows(
              "SELECT * FROM browser_surface_replacement_selection_overrides WHERE replacement_batch_id = ? ORDER BY replacement_id",
              [input.replacement_batch_id]
            ) as unknown as SelectionOverrideRow[];
            if (members.length !== input.members.length) {
              throw new ReplacementReplayConflictError("selection override batch changed reviewed member count");
            }
            const membersById = new Map(members.map((member) => [member.replacement_id, member]));
            for (const member of input.members) {
              const stored = membersById.get(member.replacement_id);
              if (!stored || stored.replacement_batch_id !== input.replacement_batch_id) {
                throw new ReplacementReplayConflictError("selection override batch changed reviewed membership");
              }
              assertOverrideReplay(stored, batchMemberOverrideInput(input, member));
            }
            const audit = dbRow(
              "SELECT reviewed_artifact_sha256 FROM browser_surface_replacement_selection_override_audit_outbox WHERE replacement_batch_id = ? AND operation = 'apply'",
              [input.replacement_batch_id]
            ) as { reviewed_artifact_sha256: string } | undefined;
            if (!audit || audit.reviewed_artifact_sha256 !== input.reviewed_artifact_sha256) {
              throw selectionOverrideError("a durable apply audit fact matching the reviewed artifact");
            }
            return batchVerification(existing, members, "apply");
          }
          const scope = assertExactBatchLedger(input, sqliteBatchLedgerRows(input));
          for (const member of input.members) {
            const override = dbRow(
              "SELECT replacement_batch_id FROM browser_surface_replacement_selection_overrides WHERE replacement_id = ?",
              [member.replacement_id]
            ) as { replacement_batch_id: string | null } | undefined;
            if (override) {
              throw selectionOverrideError(
                "members that are not already individually overridden or owned by another batch"
              );
            }
          }
          sqliteInsertBatch(input, scope);
          const batch = dbRow(
            "SELECT * FROM browser_surface_replacement_selection_override_batches WHERE replacement_batch_id = ?",
            [input.replacement_batch_id]
          ) as SelectionOverrideBatchRow | undefined;
          if (!batch) {
            throw new Error("applied selection override batch was not readable inside its transaction");
          }
          const members = dbRows(
            "SELECT * FROM browser_surface_replacement_selection_overrides WHERE replacement_batch_id = ? ORDER BY replacement_id",
            [input.replacement_batch_id]
          ) as unknown as SelectionOverrideRow[];
          const snapshot = batchVerification(batch, members, "apply");
          sqliteInsertBatchAudit(input, "apply", snapshot, input.applied_at);
          return snapshot;
        }
      )
    );
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async applySelectionOverride(input: ReplacementReceiptSelectionOverrideInput): Promise<void> {
    const existing = dbRow("SELECT * FROM browser_surface_replacement_selection_overrides WHERE replacement_id = ?", [
      input.replacement_id,
    ]);
    if (existing) {
      assertOverrideReplay(existing as unknown as SelectionOverrideRow, input);
      return;
    }
    assertOverrideTarget(sqliteOverrideTarget(input));
    execDynamicSqlAcknowledged(
      `INSERT INTO browser_surface_replacement_selection_overrides(
        replacement_id, idempotency_key, connection_id, connector_id, profile_key,
        surface_subject_id, surface_id, observed_at, prior_failed_replacement_id, applied_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      overrideParams(input) as BindValue[]
    );
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async dryRunSelectionOverrideBatch(
    input: ReplacementReceiptSelectionOverrideBatchInput
  ): Promise<ReplacementReceiptSelectionOverrideBatchVerification> {
    assertExactBatchLedger(input, sqliteBatchLedgerRows(input));
    return {
      active: false,
      audit_outbox_id: `${input.replacement_batch_id}:apply`,
      episode_id: input.episode.id,
      member_replacement_ids: input.members.map((member) => member.replacement_id).sort(),
      replacement_batch_id: input.replacement_batch_id,
      reviewed_artifact_sha256: input.reviewed_artifact_sha256,
    };
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async append(receipt: ReplacementReceipt): Promise<ReplacementReceipt> {
    const existing = dbRows(
      `SELECT * FROM browser_surface_replacement_receipts
       WHERE (idempotency_key = ? AND phase = ?) OR (replacement_id = ? AND phase = ?)
       ORDER BY event_seq`,
      [receipt.idempotency_key, receipt.phase, receipt.replacement_id, receipt.phase]
    );
    for (const row of existing) {
      const mapped = mapRow(row);
      assertSameEvent(mapped, receipt);
      return mapped;
    }
    const prior = dbRow(
      `SELECT * FROM browser_surface_replacement_receipts
       WHERE replacement_id = ? ORDER BY event_seq DESC LIMIT 1`,
      [receipt.replacement_id]
    );
    if (prior) {
      assertSameEventIdentity(mapRow(prior), receipt);
      assertNoOppositeResolution(mapRow(prior), receipt);
    }
    // REVIEWED-DYNAMIC: this append SQL is fixed but the receipt table is a runtime ledger object.
    execDynamicSqlAcknowledged(
      `INSERT INTO browser_surface_replacement_receipts(
        replacement_id, idempotency_key, scope, connection_id, connector_id, profile_key,
        surface_subject_id, run_id, lease_id, surface_id, previous_generation_hash,
        next_generation_hash, cause, phase, terminal_outcome, observed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING`,
      params(receipt) as BindValue[]
    );
    const inserted = dbRow(
      `SELECT * FROM browser_surface_replacement_receipts
       WHERE (idempotency_key = ? AND phase = ?)
          OR (replacement_id = ? AND phase IN ('completed', 'terminal'))
       ORDER BY event_seq LIMIT 1`,
      [receipt.idempotency_key, receipt.phase, receipt.replacement_id]
    );
    if (!inserted) {
      throw new Error(`replacement receipt insert ${receipt.replacement_id}/${receipt.phase} was not readable`);
    }
    const authoritative = mapRow(inserted);
    assertSameEvent(authoritative, receipt);
    return authoritative;
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async findPendingForSurface(surfaceId: string): Promise<ReplacementReceipt | null> {
    const row = dbRow(
      `SELECT started.* FROM browser_surface_replacement_receipts AS started
       WHERE started.surface_id = ? AND started.phase = 'started'
         AND NOT EXISTS (
           SELECT 1 FROM browser_surface_replacement_receipts AS resolved
           WHERE resolved.replacement_id = started.replacement_id
             AND resolved.phase IN ('completed', 'terminal')
         )
       ORDER BY started.event_seq DESC LIMIT 1`,
      [surfaceId]
    );
    return row ? mapRow(row) : null;
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async findPendingForScope(input: {
    readonly connection_id: string;
    readonly surface_subject_id: string | null;
    readonly profile_key: string;
    readonly preferred_surface_id?: string;
  }): Promise<ReplacementReceipt | null> {
    const row = dbRow(
      `SELECT started.* FROM browser_surface_replacement_receipts AS started
       WHERE started.connection_id = ?
         AND started.surface_subject_id IS ?
         AND started.profile_key = ?
         AND started.phase = 'started'
         AND NOT EXISTS (
           SELECT 1 FROM browser_surface_replacement_receipts AS resolved
           WHERE resolved.replacement_id = started.replacement_id
             AND resolved.phase IN ('completed', 'terminal')
         )
       ORDER BY CASE WHEN started.surface_id = ? THEN 0 ELSE 1 END,
                started.event_seq DESC, started.idempotency_key DESC
       LIMIT 1`,
      [input.connection_id, input.surface_subject_id, input.profile_key, input.preferred_surface_id ?? null]
    );
    return row ? mapRow(row) : null;
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async list(): Promise<readonly ReplacementReceipt[]> {
    return dbRows("SELECT * FROM browser_surface_replacement_receipts ORDER BY event_seq, idempotency_key").map(mapRow);
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async listForScope(input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
  }): Promise<readonly ReplacementReceipt[]> {
    const rows =
      input.surface_subject_id === undefined
        ? dbRows(
            `SELECT * FROM browser_surface_replacement_receipts
           WHERE connection_id = ? ORDER BY event_seq, idempotency_key`,
            [input.connection_id]
          )
        : dbRows(
            `SELECT * FROM browser_surface_replacement_receipts
           WHERE connection_id = ? AND surface_subject_id = ? ORDER BY event_seq, idempotency_key`,
            [input.connection_id, input.surface_subject_id]
          );
    return rows.map(mapRow);
  }

  async selectCurrent(input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
    readonly current_generation_hash?: string;
  }): Promise<ReplacementReceipt | null> {
    const rows = await this.listForScope(input);
    if (input.surface_subject_id === undefined) {
      const scopes = new Set(rows.map((row) => row.scope));
      if (scopes.size > 1) {
        return null;
      }
    }
    return selectCurrentReplacementReceipt(rows, input.current_generation_hash ?? null);
  }

  async selectSystemActionable(input: {
    readonly connection_id: string;
    readonly profile_key: string;
    readonly surface_subject_id?: string;
  }): Promise<ReplacementReceipt | null> {
    return selectSystemActionableForScope(await this.listForScope(input), input.profile_key, sqliteActiveOverrideIds());
  }

  // biome-ignore lint/suspicious/useAwait: sync sqlite driver; async satisfies the shared replacement ledger contract.
  async revokeSelectionOverride(replacementId: string, revokedAt: string): Promise<void> {
    execDynamicSqlAcknowledged(
      `UPDATE browser_surface_replacement_selection_overrides
       SET revoked_at = COALESCE(revoked_at, ?)
       WHERE replacement_id = ?`,
      [revokedAt, replacementId]
    );
  }

  revokeSelectionOverrideBatch(
    authorization: ReplacementSelectionOverrideBatchAuthorization,
    revokedAt: string
  ): Promise<ReplacementReceiptSelectionOverrideBatchVerification | null> {
    return Promise.resolve().then(() =>
      writeTransaction(() => {
        const expected = assertBatchAuthorization(authorization);
        const batch = dbRow(
          "SELECT * FROM browser_surface_replacement_selection_override_batches WHERE replacement_batch_id = ?",
          [expected.replacement_batch_id]
        ) as SelectionOverrideBatchRow | undefined;
        if (!batch) {
          return null;
        }
        if (
          batch.episode_id !== expected.episode_id ||
          batch.reviewed_artifact_sha256 !== expected.reviewed_artifact_sha256
        ) {
          throw selectionOverrideError("persisted batch identity and digest match the reviewed revoke artifact");
        }
        execDynamicSqlAcknowledged(
          `UPDATE browser_surface_replacement_selection_override_batches
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE replacement_batch_id = ?`,
          [revokedAt, expected.replacement_batch_id]
        );
        execDynamicSqlAcknowledged(
          `UPDATE browser_surface_replacement_selection_overrides
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE replacement_batch_id = ?`,
          [revokedAt, expected.replacement_batch_id]
        );
        const overrides = dbRows(
          "SELECT * FROM browser_surface_replacement_selection_overrides WHERE replacement_batch_id = ? ORDER BY replacement_id",
          [expected.replacement_batch_id]
        ) as unknown as SelectionOverrideRow[];
        const snapshot = batchVerification(
          { ...batch, revoked_at: batch.revoked_at ?? revokedAt },
          overrides,
          "revoke"
        );
        const priorAudit = dbRow(
          "SELECT audit_outbox_id FROM browser_surface_replacement_selection_override_audit_outbox WHERE replacement_batch_id = ? AND operation = 'revoke'",
          [expected.replacement_batch_id]
        );
        if (!priorAudit) {
          sqliteInsertBatchAudit(batch, "revoke", snapshot, revokedAt);
        }
        return snapshot;
      })
    );
  }

  verifySelectionOverrideBatch(batchId: string): Promise<ReplacementReceiptSelectionOverrideBatchVerification | null> {
    return Promise.resolve(transaction(() => this.#verifySelectionOverrideBatch(batchId)));
  }

  #verifySelectionOverrideBatch(batchId: string): ReplacementReceiptSelectionOverrideBatchVerification | null {
    const batch = dbRow(
      "SELECT * FROM browser_surface_replacement_selection_override_batches WHERE replacement_batch_id = ?",
      [batchId]
    ) as SelectionOverrideBatchRow | undefined;
    if (!batch) {
      return null;
    }
    const overrides = dbRows(
      "SELECT * FROM browser_surface_replacement_selection_overrides WHERE replacement_batch_id = ? ORDER BY replacement_id",
      [batchId]
    ) as unknown as SelectionOverrideRow[];
    const members = overrides.map((override) => {
      const row = dbRow(
        "SELECT * FROM browser_surface_replacement_receipts WHERE replacement_id = ? AND phase = 'started'",
        [override.replacement_id]
      ) as ReplacementReceiptRow | undefined;
      if (row?.cause !== "external_or_host_loss") {
        throw selectionOverrideError("persisted batch members with started receipts");
      }
      return {
        connection_id: row.connection_id,
        connector_id: row.connector_id,
        event_seq: Number(row.event_seq),
        idempotency_key: row.idempotency_key,
        observed_at: row.observed_at,
        profile_key: row.profile_key,
        replacement_id: row.replacement_id,
        scope: row.scope,
        surface_id: row.surface_id ?? "",
        surface_subject_id: row.surface_subject_id,
      } satisfies ReplacementReceiptSelectionOverrideBatchMember;
    });
    const input: ReplacementReceiptSelectionOverrideBatchInput = {
      applied_at: batch.applied_at,
      episode: {
        first_event_seq: Number(batch.first_event_seq),
        first_observed_at: batch.first_observed_at,
        id: batch.episode_id,
        last_event_seq: Number(batch.last_event_seq),
        last_observed_at: batch.last_observed_at,
      },
      members,
      prior_failed_replacement_id: batch.prior_failed_replacement_id,
      replacement_batch_id: batch.replacement_batch_id,
      reviewed_artifact_sha256: batch.reviewed_artifact_sha256,
    };
    const scope = assertPersistedBatchSnapshot(batch, input);
    for (const member of members) {
      const override = overrides.find((row) => row.replacement_id === member.replacement_id);
      if (!override || override.replacement_batch_id !== batchId) {
        throw selectionOverrideError("persisted batch membership");
      }
      assertOverrideReplay(override, batchMemberOverrideInput(input, member));
    }
    const prior = dbRows(
      "SELECT * FROM browser_surface_replacement_receipts WHERE replacement_id = ? AND phase IN ('started', 'terminal')",
      [batch.prior_failed_replacement_id]
    );
    const priorStarted = prior.find((row) => row.phase === "started");
    const priorTerminal = prior.find((row) => row.phase === "terminal");
    if (
      !(
        priorStarted &&
        priorTerminal &&
        priorStarted.cause === "external_or_host_loss" &&
        priorTerminal.cause === "external_or_host_loss" &&
        priorTerminal.terminal_outcome === "failed" &&
        priorStarted.connection_id === scope.connection_id &&
        priorStarted.connector_id === scope.connector_id &&
        priorStarted.profile_key === scope.profile_key &&
        priorStarted.surface_subject_id === scope.surface_subject_id
      )
    ) {
      throw selectionOverrideError("persisted failed predecessor fingerprint");
    }
    return batchVerification(batch, overrides, "apply");
  }
}

class PostgresBrowserSurfaceReplacementReceiptStore implements BrowserSurfaceReplacementReceiptStore {
  readonly #query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: ReplacementReceiptRow[] }>;

  constructor(query?: (sql: string, values?: readonly unknown[]) => Promise<{ rows: ReplacementReceiptRow[] }>) {
    this.#query =
      query ??
      ((sql, values = []) =>
        postgresQuery<ReplacementReceiptRow>(sql, [...values]) as Promise<{ rows: ReplacementReceiptRow[] }>);
  }

  applySelectionOverrideBatch(
    input: ReplacementReceiptSelectionOverrideBatchInput
  ): Promise<ReplacementReceiptSelectionOverrideBatchVerification> {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: PostgreSQL keeps the lock, exact replay, admission, atomic writes, and durable audit fact in one visible transaction.
    return withPostgresTransaction(async (client) => {
      const query: PostgresLedgerQuery = (sql, values = []) =>
        client.query<ReplacementReceiptRow>(sql, [...values]) as Promise<{ rows: ReplacementReceiptRow[] }>;
      // The validator compares the entire later-start set. Lock its source
      // table before reading so an append cannot slip between validation and
      // the all-or-nothing override inserts.
      await query("LOCK TABLE browser_surface_replacement_receipts IN SHARE ROW EXCLUSIVE MODE");
      await query("LOCK TABLE browser_surface_replacement_selection_overrides IN SHARE ROW EXCLUSIVE MODE");
      const inputScope = assertExactBatchInput(input);
      const existing = await query(
        "SELECT * FROM browser_surface_replacement_selection_override_batches WHERE replacement_batch_id = $1 FOR UPDATE",
        [input.replacement_batch_id]
      );
      const existingRow = existing.rows[0] as unknown as SelectionOverrideBatchRow | undefined;
      if (existingRow) {
        assertBatchReplay(existingRow, input, inputScope);
        const storedMembers = await query(
          "SELECT * FROM browser_surface_replacement_selection_overrides WHERE replacement_batch_id = $1 ORDER BY replacement_id",
          [input.replacement_batch_id]
        );
        if (storedMembers.rows.length !== input.members.length) {
          throw new ReplacementReplayConflictError("selection override batch changed reviewed member count");
        }
        const membersById = new Map(
          storedMembers.rows.map((member) => [member.replacement_id, member as unknown as SelectionOverrideRow])
        );
        for (const member of input.members) {
          const stored = membersById.get(member.replacement_id);
          if (!stored || stored.replacement_batch_id !== input.replacement_batch_id) {
            throw new ReplacementReplayConflictError("selection override batch changed reviewed membership");
          }
          assertOverrideReplay(stored, batchMemberOverrideInput(input, member));
        }
        const audit = await query(
          "SELECT reviewed_artifact_sha256 FROM browser_surface_replacement_selection_override_audit_outbox WHERE replacement_batch_id = $1 AND operation = 'apply'",
          [input.replacement_batch_id]
        );
        if (!audit.rows[0] || audit.rows[0].reviewed_artifact_sha256 !== input.reviewed_artifact_sha256) {
          throw selectionOverrideError("a durable apply audit fact matching the reviewed artifact");
        }
        return batchVerification(existingRow, storedMembers.rows as unknown as SelectionOverrideRow[], "apply");
      }
      const scope = assertExactBatchLedger(input, await postgresBatchLedgerRows(query, input));
      for (const member of input.members) {
        // biome-ignore lint/performance/noAwaitInLoops: each row is locked before the batch claims it.
        const existingOverride = await query(
          "SELECT replacement_batch_id FROM browser_surface_replacement_selection_overrides WHERE replacement_id = $1 FOR UPDATE",
          [member.replacement_id]
        );
        if (existingOverride.rows[0]) {
          throw selectionOverrideError(
            "members that are not already individually overridden or owned by another batch"
          );
        }
      }
      await postgresInsertBatch(query, input, scope);
      const batch = await query(
        "SELECT * FROM browser_surface_replacement_selection_override_batches WHERE replacement_batch_id = $1",
        [input.replacement_batch_id]
      );
      const batchRow = batch.rows[0] as unknown as SelectionOverrideBatchRow | undefined;
      if (!batchRow) {
        throw new Error("applied selection override batch was not readable inside its transaction");
      }
      const members = (
        await query(
          "SELECT * FROM browser_surface_replacement_selection_overrides WHERE replacement_batch_id = $1 ORDER BY replacement_id",
          [input.replacement_batch_id]
        )
      ).rows as unknown as SelectionOverrideRow[];
      const snapshot = batchVerification(batchRow, members, "apply");
      await postgresInsertBatchAudit(query, input, "apply", snapshot, input.applied_at);
      return snapshot;
    });
  }

  async applySelectionOverride(input: ReplacementReceiptSelectionOverrideInput): Promise<void> {
    const existing = await this.#query(
      "SELECT * FROM browser_surface_replacement_selection_overrides WHERE replacement_id = $1",
      [input.replacement_id]
    );
    const [existingRow] = existing.rows;
    if (existingRow) {
      assertOverrideReplay(existingRow as unknown as SelectionOverrideRow, input);
      return;
    }
    assertOverrideTarget(await postgresOverrideTarget((sql, bind) => this.#query(sql, bind), input));
    await this.#query(
      `INSERT INTO browser_surface_replacement_selection_overrides(
        replacement_id, idempotency_key, connection_id, connector_id, profile_key,
        surface_subject_id, surface_id, observed_at, prior_failed_replacement_id, applied_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      overrideParams(input)
    );
  }

  dryRunSelectionOverrideBatch(
    input: ReplacementReceiptSelectionOverrideBatchInput
  ): Promise<ReplacementReceiptSelectionOverrideBatchVerification> {
    return withPostgresReadOnlyTransaction(async (client) => {
      const query: PostgresLedgerQuery = (sql, values = []) =>
        client.query<ReplacementReceiptRow>(sql, [...values]) as Promise<{ rows: ReplacementReceiptRow[] }>;
      assertExactBatchLedger(input, await postgresBatchLedgerRows(query, input));
      return {
        active: false,
        audit_outbox_id: `${input.replacement_batch_id}:apply`,
        episode_id: input.episode.id,
        member_replacement_ids: input.members.map((member) => member.replacement_id).sort(),
        replacement_batch_id: input.replacement_batch_id,
        reviewed_artifact_sha256: input.reviewed_artifact_sha256,
      };
    });
  }

  async append(receipt: ReplacementReceipt): Promise<ReplacementReceipt> {
    const existing = await this.#query(
      `SELECT * FROM browser_surface_replacement_receipts
       WHERE (idempotency_key = $1 AND phase = $2) OR (replacement_id = $3 AND phase = $4)
       ORDER BY event_seq`,
      [receipt.idempotency_key, receipt.phase, receipt.replacement_id, receipt.phase]
    );
    for (const row of existing.rows) {
      const mapped = mapRow(row);
      assertSameEvent(mapped, receipt);
      return mapped;
    }
    const prior = await this.#query(
      `SELECT * FROM browser_surface_replacement_receipts
       WHERE replacement_id = $1 ORDER BY event_seq DESC LIMIT 1`,
      [receipt.replacement_id]
    );
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const priorRow = prior.rows[0];
    if (priorRow) {
      assertSameEventIdentity(mapRow(priorRow), receipt);
      assertNoOppositeResolution(mapRow(priorRow), receipt);
    }
    const inserted = await this.#query(
      `INSERT INTO browser_surface_replacement_receipts(
        replacement_id, idempotency_key, scope, connection_id, connector_id, profile_key,
        surface_subject_id, run_id, lease_id, surface_id, previous_generation_hash,
        next_generation_hash, cause, phase, terminal_outcome, observed_at
      ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT DO NOTHING
      RETURNING *`,
      params(receipt)
    );
    const row =
      inserted.rows[0] ??
      (
        await this.#query(
          `SELECT * FROM browser_surface_replacement_receipts
       WHERE (idempotency_key = $1 AND phase = $2)
          OR (replacement_id = $3 AND phase IN ('completed', 'terminal'))
       ORDER BY event_seq LIMIT 1`,
          [receipt.idempotency_key, receipt.phase, receipt.replacement_id]
        )
      ).rows[0];
    if (!row) {
      throw new Error(`replacement receipt insert ${receipt.replacement_id}/${receipt.phase} was not readable`);
    }
    const authoritative = mapRow(row);
    assertSameEvent(authoritative, receipt);
    return authoritative;
  }

  async findPendingForSurface(surfaceId: string): Promise<ReplacementReceipt | null> {
    const result = await this.#query(
      `SELECT started.* FROM browser_surface_replacement_receipts AS started
       WHERE started.surface_id = $1 AND started.phase = 'started'
         AND NOT EXISTS (
           SELECT 1 FROM browser_surface_replacement_receipts AS resolved
           WHERE resolved.replacement_id = started.replacement_id
             AND resolved.phase IN ('completed', 'terminal')
         )
       ORDER BY started.event_seq DESC LIMIT 1`,
      [surfaceId]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findPendingForScope(input: {
    readonly connection_id: string;
    readonly surface_subject_id: string | null;
    readonly profile_key: string;
    readonly preferred_surface_id?: string;
  }): Promise<ReplacementReceipt | null> {
    const result = await this.#query(
      `SELECT started.* FROM browser_surface_replacement_receipts AS started
       WHERE started.connection_id = $1
         AND started.surface_subject_id IS NOT DISTINCT FROM $2
         AND started.profile_key = $3
         AND started.phase = 'started'
         AND NOT EXISTS (
           SELECT 1 FROM browser_surface_replacement_receipts AS resolved
           WHERE resolved.replacement_id = started.replacement_id
             AND resolved.phase IN ('completed', 'terminal')
         )
       ORDER BY CASE WHEN $4::text IS NOT NULL AND started.surface_id = $4::text THEN 0 ELSE 1 END,
                started.event_seq DESC, started.idempotency_key DESC
       LIMIT 1`,
      [input.connection_id, input.surface_subject_id, input.profile_key, input.preferred_surface_id ?? null]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async list(): Promise<readonly ReplacementReceipt[]> {
    const result = await this.#query(
      "SELECT * FROM browser_surface_replacement_receipts ORDER BY event_seq, idempotency_key"
    );
    return result.rows.map(mapRow);
  }

  async listForScope(input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
  }): Promise<readonly ReplacementReceipt[]> {
    const result =
      input.surface_subject_id === undefined
        ? await this.#query(
            `SELECT * FROM browser_surface_replacement_receipts
           WHERE connection_id = $1 ORDER BY event_seq, idempotency_key`,
            [input.connection_id]
          )
        : await this.#query(
            `SELECT * FROM browser_surface_replacement_receipts
           WHERE connection_id = $1 AND surface_subject_id = $2 ORDER BY event_seq, idempotency_key`,
            [input.connection_id, input.surface_subject_id]
          );
    return result.rows.map(mapRow);
  }

  async selectCurrent(input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
    readonly current_generation_hash?: string;
  }): Promise<ReplacementReceipt | null> {
    const rows = await this.listForScope(input);
    if (input.surface_subject_id === undefined) {
      const scopes = new Set(rows.map((row) => row.scope));
      if (scopes.size > 1) {
        return null;
      }
    }
    return selectCurrentReplacementReceipt(rows, input.current_generation_hash ?? null);
  }

  async selectSystemActionable(input: {
    readonly connection_id: string;
    readonly profile_key: string;
    readonly surface_subject_id?: string;
  }): Promise<ReplacementReceipt | null> {
    return selectSystemActionableForScope(
      await this.listForScope(input),
      input.profile_key,
      await postgresActiveOverrideIds((sql, bind) => this.#query(sql, bind))
    );
  }

  async revokeSelectionOverride(replacementId: string, revokedAt: string): Promise<void> {
    await this.#query(
      `UPDATE browser_surface_replacement_selection_overrides
       SET revoked_at = COALESCE(revoked_at, $1)
       WHERE replacement_id = $2`,
      [revokedAt, replacementId]
    );
  }

  revokeSelectionOverrideBatch(
    authorization: ReplacementSelectionOverrideBatchAuthorization,
    revokedAt: string
  ): Promise<ReplacementReceiptSelectionOverrideBatchVerification | null> {
    return withPostgresTransaction(async (client) => {
      const query: PostgresLedgerQuery = (sql, values = []) =>
        client.query<ReplacementReceiptRow>(sql, [...values]) as Promise<{ rows: ReplacementReceiptRow[] }>;
      const expected = assertBatchAuthorization(authorization);
      const batchResult = await query(
        "SELECT * FROM browser_surface_replacement_selection_override_batches WHERE replacement_batch_id = $1 FOR UPDATE",
        [expected.replacement_batch_id]
      );
      const batch = batchResult.rows[0] as unknown as SelectionOverrideBatchRow | undefined;
      if (!batch) {
        return null;
      }
      if (
        batch.episode_id !== expected.episode_id ||
        batch.reviewed_artifact_sha256 !== expected.reviewed_artifact_sha256
      ) {
        throw selectionOverrideError("persisted batch identity and digest match the reviewed revoke artifact");
      }
      await query(
        `UPDATE browser_surface_replacement_selection_override_batches
         SET revoked_at = COALESCE(revoked_at, $1)
         WHERE replacement_batch_id = $2`,
        [revokedAt, expected.replacement_batch_id]
      );
      await query(
        `UPDATE browser_surface_replacement_selection_overrides
         SET revoked_at = COALESCE(revoked_at, $1)
         WHERE replacement_batch_id = $2`,
        [revokedAt, expected.replacement_batch_id]
      );
      const overrides = (
        await query(
          "SELECT * FROM browser_surface_replacement_selection_overrides WHERE replacement_batch_id = $1 ORDER BY replacement_id",
          [expected.replacement_batch_id]
        )
      ).rows as unknown as SelectionOverrideRow[];
      const snapshot = batchVerification({ ...batch, revoked_at: batch.revoked_at ?? revokedAt }, overrides, "revoke");
      const priorAudit = await query(
        "SELECT audit_outbox_id FROM browser_surface_replacement_selection_override_audit_outbox WHERE replacement_batch_id = $1 AND operation = 'revoke'",
        [expected.replacement_batch_id]
      );
      if (!priorAudit.rows[0]) {
        await postgresInsertBatchAudit(query, batch, "revoke", snapshot, revokedAt);
      }
      return snapshot;
    });
  }

  verifySelectionOverrideBatch(batchId: string): Promise<ReplacementReceiptSelectionOverrideBatchVerification | null> {
    return withPostgresReadOnlyTransaction(async (client) => {
      const query: PostgresLedgerQuery = (sql, values = []) =>
        client.query<ReplacementReceiptRow>(sql, [...values]) as Promise<{ rows: ReplacementReceiptRow[] }>;
      const batchResult = await query(
        "SELECT * FROM browser_surface_replacement_selection_override_batches WHERE replacement_batch_id = $1",
        [batchId]
      );
      const batch = batchResult.rows[0] as unknown as SelectionOverrideBatchRow | undefined;
      if (!batch) {
        return null;
      }
      const overrides = (
        await query(
          "SELECT * FROM browser_surface_replacement_selection_overrides WHERE replacement_batch_id = $1 ORDER BY replacement_id",
          [batchId]
        )
      ).rows as unknown as SelectionOverrideRow[];
      const receiptRows = await query(
        "SELECT * FROM browser_surface_replacement_receipts WHERE replacement_id = ANY($1::text[]) AND phase = 'started'",
        [overrides.map((override) => override.replacement_id)]
      );
      const receiptByReplacementId = new Map(receiptRows.rows.map((row) => [row.replacement_id, row]));
      const members = overrides.map((override) => {
        const row = receiptByReplacementId.get(override.replacement_id);
        if (!row) {
          throw selectionOverrideError("persisted batch members with started receipts");
        }
        return {
          connection_id: row.connection_id,
          connector_id: row.connector_id,
          event_seq: Number(row.event_seq),
          idempotency_key: row.idempotency_key,
          observed_at: row.observed_at,
          profile_key: row.profile_key,
          replacement_id: row.replacement_id,
          scope: row.scope,
          surface_id: row.surface_id ?? "",
          surface_subject_id: row.surface_subject_id,
        } satisfies ReplacementReceiptSelectionOverrideBatchMember;
      });
      const input: ReplacementReceiptSelectionOverrideBatchInput = {
        applied_at: batch.applied_at,
        episode: {
          first_event_seq: Number(batch.first_event_seq),
          first_observed_at: batch.first_observed_at,
          id: batch.episode_id,
          last_event_seq: Number(batch.last_event_seq),
          last_observed_at: batch.last_observed_at,
        },
        members,
        prior_failed_replacement_id: batch.prior_failed_replacement_id,
        replacement_batch_id: batch.replacement_batch_id,
        reviewed_artifact_sha256: batch.reviewed_artifact_sha256,
      };
      const scope = assertPersistedBatchSnapshot(batch, input);
      for (const member of members) {
        const override = overrides.find((row) => row.replacement_id === member.replacement_id);
        if (!override || override.replacement_batch_id !== batchId) {
          throw selectionOverrideError("persisted batch membership");
        }
        assertOverrideReplay(override, batchMemberOverrideInput(input, member));
      }
      const prior = await query(
        "SELECT * FROM browser_surface_replacement_receipts WHERE replacement_id = $1 AND phase IN ('started', 'terminal')",
        [batch.prior_failed_replacement_id]
      );
      const priorStarted = prior.rows.find((row) => row.phase === "started");
      const priorTerminal = prior.rows.find((row) => row.phase === "terminal");
      if (
        !(
          priorStarted &&
          priorTerminal &&
          priorStarted.cause === "external_or_host_loss" &&
          priorTerminal.cause === "external_or_host_loss" &&
          priorTerminal.terminal_outcome === "failed" &&
          priorStarted.connection_id === scope.connection_id &&
          priorStarted.connector_id === scope.connector_id &&
          priorStarted.profile_key === scope.profile_key &&
          priorStarted.surface_subject_id === scope.surface_subject_id
        )
      ) {
        throw selectionOverrideError("persisted failed predecessor fingerprint");
      }
      return batchVerification(batch, overrides, "apply");
    });
  }
}

function selectSystemActionableForScope(
  receipts: readonly ReplacementReceipt[],
  profileKey: string,
  excludedReplacementIds: ReadonlySet<string>
): ReplacementReceipt | null {
  if (new Set(receipts.map((receipt) => receipt.scope)).size > 1) {
    return null;
  }
  return selectSystemActionableReplacementReceipt(
    receipts.filter(
      (receipt) => receipt.profile_key === profileKey && !excludedReplacementIds.has(receipt.replacement_id)
    )
  );
}

function assertSameEventIdentity(previous: ReplacementReceipt, incoming: ReplacementReceipt): void {
  const fields: readonly (keyof ReplacementReceipt)[] = [
    "replacement_id",
    "scope",
    "connection_id",
    "connector_id",
    "profile_key",
    "surface_subject_id",
    "run_id",
    "lease_id",
    "surface_id",
    "previous_generation_hash",
    "cause",
  ];
  for (const field of fields) {
    if (previous[field] !== incoming[field]) {
      throw new ReplacementReplayConflictError(
        `replacement ${previous.replacement_id} immutable field ${field} changed`
      );
    }
  }
}

function assertNoOppositeResolution(previous: ReplacementReceipt, incoming: ReplacementReceipt): void {
  if (isResolution(previous.phase) && isResolution(incoming.phase) && previous.phase !== incoming.phase) {
    throw new ReplacementReplayConflictError(
      `replacement ${incoming.replacement_id} already resolved as ${previous.phase}`
    );
  }
}

function isResolution(phase: ReplacementReceipt["phase"]): boolean {
  return phase === "completed" || phase === "terminal";
}

function dbRows(sql: string, bind: readonly unknown[] = []): ReplacementReceiptRow[] {
  return [...iterateDynamicSqlAcknowledged<ReplacementReceiptRow>(sql, bind as BindValue[])];
}

function dbRow(sql: string, bind: readonly unknown[] = []): ReplacementReceiptRow | undefined {
  for (const row of iterateDynamicSqlAcknowledged<ReplacementReceiptRow>(sql, bind as BindValue[])) {
    return row;
  }
  // biome-ignore lint/complexity/noUselessReturn: required by TypeScript noImplicitReturns to make the empty result explicit.
  return;
}

export function createSqliteBrowserSurfaceReplacementReceiptStore(): BrowserSurfaceReplacementReceiptStore {
  return new SqliteBrowserSurfaceReplacementReceiptStore();
}

export function createPostgresBrowserSurfaceReplacementReceiptStore(
  query?: (sql: string, values?: readonly unknown[]) => Promise<{ rows: ReplacementReceiptRow[] }>
): BrowserSurfaceReplacementReceiptStore {
  return new PostgresBrowserSurfaceReplacementReceiptStore(query);
}

export function createBrowserSurfaceReplacementReceiptStore(): BrowserSurfaceReplacementReceiptStore {
  return isPostgresStorageBackend()
    ? createPostgresBrowserSurfaceReplacementReceiptStore()
    : createSqliteBrowserSurfaceReplacementReceiptStore();
}

export function getDefaultBrowserSurfaceReplacementReceiptStore(): BrowserSurfaceReplacementReceiptStore {
  const backend = getStorageBackendKind();
  if (backend === "postgres") {
    return createPostgresBrowserSurfaceReplacementReceiptStore();
  }
  return createSqliteBrowserSurfaceReplacementReceiptStore();
}
