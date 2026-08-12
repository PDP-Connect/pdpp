// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { getOneOn, referenceQueries } from "../../lib/db.ts";
import { appendPostgresSpineEventInTransaction, type PostgresSpineEventInput } from "../../lib/postgres-spine.ts";
import { appendSqliteSpineEventInTransaction, type SpineDatabase, type SpineEventInput } from "../../lib/spine.ts";
import { getDb } from "../db.ts";
import { isPostgresStorageBackend, withPostgresTransaction } from "../postgres-storage.ts";
import {
  putPostgresConnectorStateDeltaInTransaction,
  putSqliteConnectorStateDeltaInTransaction,
} from "./connector-state-store.ts";

export interface ResolvedTerminalRunCommit {
  readonly collectionBoundary: string;
  readonly commitId: string;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly deviceId: string;
  readonly envelopeHash: string;
  readonly normalizedFacts: readonly Record<string, unknown>[];
  readonly runId: string;
  readonly sourceInstanceId: string;
  readonly stateDelta: Readonly<Record<string, unknown>>;
}

export interface TerminalRunCommitResponse {
  readonly commit_id: string;
  readonly envelope_hash: string;
  readonly object: "device_terminal_run_commit";
  readonly run_id: string;
  readonly terminal_event_id: string;
}

export interface TerminalRunCommitResult {
  readonly replayed: boolean;
  readonly response: TerminalRunCommitResponse;
}

export class TerminalRunCommitConflictError extends Error {
  readonly code = "terminal_run_commit_conflict";

  constructor() {
    super("Terminal run commit identity is already bound to a different request.");
    this.name = "TerminalRunCommitConflictError";
  }
}

type TerminalFaultPoint = "after_event_insert" | "after_run_history_write" | `after_state_write:${string}`;
let terminalRunCommitFaultHook: ((point: TerminalFaultPoint) => void) | null = null;

export function __setTerminalRunCommitFaultHookForTest(hook: ((point: TerminalFaultPoint) => void) | null): void {
  terminalRunCommitFaultHook = hook;
}

function maybeFault(point: TerminalFaultPoint): void {
  terminalRunCommitFaultHook?.(point);
}

function terminalRunBindingIdentity(input: ResolvedTerminalRunCommit): string {
  return JSON.stringify([
    input.deviceId,
    input.sourceInstanceId,
    input.connectorId,
    input.connectorInstanceId,
    input.runId,
  ]);
}

function terminalEventId(input: ResolvedTerminalRunCommit): string {
  return `evt_local_terminal_commit_${createHash("sha256").update(terminalRunBindingIdentity(input)).digest("hex")}`;
}

function responseFor(input: ResolvedTerminalRunCommit, eventId: string): TerminalRunCommitResponse {
  return {
    commit_id: input.commitId,
    envelope_hash: input.envelopeHash,
    object: "device_terminal_run_commit",
    run_id: input.runId,
    terminal_event_id: eventId,
  };
}

function eventInputFor(
  input: ResolvedTerminalRunCommit,
  eventId: string,
  response: TerminalRunCommitResponse,
  occurredAt: string
): SpineEventInput & PostgresSpineEventInput {
  return {
    actor_id: input.deviceId,
    actor_type: "local_device",
    data: {
      collection_facts: {
        collection_scope: input.collectionBoundary,
        reference_only: true,
        schema_version: 1,
        streams: input.normalizedFacts,
      },
      connector_instance_id: input.connectorInstanceId,
      terminal_run_commit_receipt: {
        bindings: {
          connector_id: input.connectorId,
          connector_instance_id: input.connectorInstanceId,
          device_id: input.deviceId,
          run_id: input.runId,
          source_instance_id: input.sourceInstanceId,
        },
        commit_id: input.commitId,
        envelope_hash: input.envelopeHash,
        response,
        version: 1,
      },
    },
    event_id: eventId,
    event_type: "run.completed",
    object_id: input.runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: input.runId,
    source_id: input.connectorId,
    source_kind: "connector",
    status: "succeeded",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseStoredResponse(dataJson: unknown, input: ResolvedTerminalRunCommit): TerminalRunCommitResponse | null {
  let data: unknown = dataJson;
  if (typeof dataJson === "string") {
    try {
      data = JSON.parse(dataJson) as unknown;
    } catch {
      return null;
    }
  }
  const receipt = asRecord(asRecord(data)?.terminal_run_commit_receipt);
  const bindings = asRecord(receipt?.bindings);
  const response = asRecord(receipt?.response);
  const exactReceiptFields = [
    receipt?.version === 1,
    receipt?.commit_id === input.commitId,
    receipt?.envelope_hash === input.envelopeHash,
    bindings?.device_id === input.deviceId,
    bindings?.source_instance_id === input.sourceInstanceId,
    bindings?.connector_id === input.connectorId,
    bindings?.connector_instance_id === input.connectorInstanceId,
    bindings?.run_id === input.runId,
    response?.object === "device_terminal_run_commit",
    response?.commit_id === input.commitId,
    response?.envelope_hash === input.envelopeHash,
    response?.run_id === input.runId,
    typeof response?.terminal_event_id === "string",
  ];
  if (!exactReceiptFields.every(Boolean)) {
    return null;
  }
  return response as unknown as TerminalRunCommitResponse;
}

function rollbackSqlite(db: ReturnType<typeof getDb>): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the original transactional failure.
  }
}

function commitSqlite(input: ResolvedTerminalRunCommit): TerminalRunCommitResult {
  const db = getDb();
  const eventId = terminalEventId(input);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = getOneOn<{ data_json: string }>(db, referenceQueries.spineGetTerminalRunCommitReceipt, [eventId]);
    if (existing) {
      const stored = parseStoredResponse(existing.data_json, input);
      if (!stored) {
        throw new TerminalRunCommitConflictError();
      }
      db.exec("COMMIT");
      return { replayed: true, response: stored };
    }

    const occurredAt = new Date().toISOString();
    const response = responseFor(input, eventId);
    putSqliteConnectorStateDeltaInTransaction(
      db,
      { connectorId: input.connectorId, connectorInstanceId: input.connectorInstanceId },
      input.stateDelta,
      occurredAt,
      { afterStateWrite: (stream) => maybeFault(`after_state_write:${stream}`) }
    );
    appendSqliteSpineEventInTransaction(
      eventInputFor(input, eventId, response, occurredAt),
      db as unknown as SpineDatabase,
      {
        afterEventInsert: () => maybeFault("after_event_insert"),
        afterRunHistoryWrite: () => maybeFault("after_run_history_write"),
      }
    );
    db.exec("COMMIT");
    return { replayed: false, response };
  } catch (error) {
    rollbackSqlite(db);
    throw error;
  }
}

async function commitPostgres(input: ResolvedTerminalRunCommit): Promise<TerminalRunCommitResult> {
  const eventId = terminalEventId(input);
  return await withPostgresTransaction(async (client) => {
    // Serialize equal authorized run bindings before lookup/insert. This avoids a
    // 23505-aborted transaction on concurrent divergent bodies while exposing
    // no incumbent receipt fields to the losing caller.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [terminalRunBindingIdentity(input)]);
    const existing = await client.query<{ data_json: unknown }>(
      "SELECT data_json FROM spine_events WHERE event_id = $1",
      [eventId]
    );
    if (existing.rows[0]) {
      const stored = parseStoredResponse(existing.rows[0].data_json, input);
      if (!stored) {
        throw new TerminalRunCommitConflictError();
      }
      return { replayed: true, response: stored };
    }

    const occurredAt = new Date().toISOString();
    const response = responseFor(input, eventId);
    await putPostgresConnectorStateDeltaInTransaction(
      client,
      { connectorId: input.connectorId, connectorInstanceId: input.connectorInstanceId },
      input.stateDelta,
      occurredAt,
      { afterStateWrite: (stream) => maybeFault(`after_state_write:${stream}`) }
    );
    await appendPostgresSpineEventInTransaction(client, eventInputFor(input, eventId, response, occurredAt), {
      afterEventInsert: () => maybeFault("after_event_insert"),
      afterRunHistoryWrite: () => maybeFault("after_run_history_write"),
    });
    return { replayed: false, response };
  });
}

export async function commitTerminalRun(input: ResolvedTerminalRunCommit): Promise<TerminalRunCommitResult> {
  return isPostgresStorageBackend() ? await commitPostgres(input) : commitSqlite(input);
}
