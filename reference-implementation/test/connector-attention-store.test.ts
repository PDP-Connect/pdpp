// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance tests for the durable structured-attention store and its
 * wiring into the reference operator-console connector projections.
 *
 * Covers:
 *   - structured rows drive `needs_attention` with `next_action.source ===
 *     "structured"` in both list and detail surfaces;
 *   - structured attention beats schedule fallback even when both are present;
 *   - secret-sensitive structured attention suppresses `action_target`;
 *   - expired / resolved / superseded rows do not drive health;
 *   - attention-store read failure forces `unknown`, not a false healthy;
 *   - connector instance scoping isolates one connection's attention from
 *     another.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: better-sqlite3 is the real driver under test.
import Database from "better-sqlite3";
import { createTraceContext, emitSpineEvent } from "../lib/spine.ts";
import { createAttention, transition } from "../runtime/attention.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  type ConnectorRunSummary,
  getConnectorAttentionProjection,
  projectConnectorSummaryConnectionHealth,
} from "../server/ref-control.ts";
import {
  createPostgresConnectorAttentionStore,
  createSqliteConnectorAttentionStore,
  getDefaultConnectorAttentionStore,
  resetDefaultConnectorAttentionStoreCache,
} from "../server/stores/connector-attention-store.ts";

const REGEXP_1 = /terminal/;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function withTempDb(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-attention-store-"));
    resetDefaultConnectorAttentionStoreCache();
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn(dir);
    } finally {
      closeDb();
      resetDefaultConnectorAttentionStoreCache();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function failedRun(overrides: Partial<ConnectorRunSummary> = {}): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 1,
    failure_reason: "manual_verification_required",
    finished_at: "2026-05-19T12:00:00.000Z",
    first_at: "2026-05-19T11:59:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T12:00:00.000Z",
    recovery_only: false,
    run_id: "run_failed",
    started_at: "2026-05-19T11:59:00.000Z",
    status: "failed",
    terminal_reason: null,
    ...overrides,
  };
}

function succeededRun(overrides: Partial<ConnectorRunSummary> = {}): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 1,
    failure_reason: null,
    finished_at: "2026-05-19T12:00:00.000Z",
    first_at: "2026-05-19T11:59:00.000Z",
    known_gaps: [],
    last_at: "2026-05-19T12:00:00.000Z",
    recovery_only: false,
    run_id: "run_ok",
    started_at: "2026-05-19T11:59:00.000Z",
    status: "succeeded",
    terminal_reason: null,
    ...overrides,
  };
}

interface PersistedAttentionRow {
  lifecycle: string;
  record_json: string;
  updated_at?: string;
}

function requirePersistedAttentionRow(value: unknown): PersistedAttentionRow {
  assert.ok(value, "expected persisted attention row");
  const row = value as Record<string, unknown>;
  if (typeof row.lifecycle !== "string" || typeof row.record_json !== "string") {
    throw new Error("persisted attention row has an invalid shape");
  }
  return {
    lifecycle: row.lifecycle,
    record_json: row.record_json,
    ...(typeof row.updated_at === "string" ? { updated_at: row.updated_at } : {}),
  };
}

test(
  "attention page batch is exact-instance, expiry-aware, empty-safe, and has page-bounded SQLite work",
  withTempDb(async () => {
    const store = createSqliteConnectorAttentionStore();
    const now = "2026-05-19T12:00:00.000Z";
    const first = "cin_attention_batch_first";
    const second = "cin_attention_batch_second";
    await store.upsertAttention({
      connectorId: "batch_connector",
      connectorInstanceId: first,
      record: createAttention({
        action_target: "dashboard",
        connection_id: "batch_connector",
        dedupe_key: "first",
        id: "att_first",
        now: "2026-05-19T11:50:00.000Z",
        owner_action: "provide_value",
        progress_posture: "blocked",
        reason_code: "otp_required",
        response_contract: "response_required",
        sensitivity: "non_secret",
      }),
    });
    await store.upsertAttention({
      connectorId: "batch_connector",
      connectorInstanceId: second,
      record: createAttention({
        action_target: "dashboard",
        connection_id: "batch_connector",
        dedupe_key: "expired",
        expires_at: "2026-05-19T11:59:00.000Z",
        id: "att_expired",
        now: "2026-05-19T11:50:00.000Z",
        owner_action: "provide_value",
        progress_posture: "blocked",
        reason_code: "otp_required",
        response_contract: "response_required",
        sensitivity: "non_secret",
      }),
    });

    const originalPrepare = Database.prototype.prepare;
    let membershipStatements = 0;
    Database.prototype.prepare = function prepareWithMembershipCounter(sql: string) {
      if (sql.includes("connector_instance_id IN")) {
        membershipStatements += 1;
      }
      return originalPrepare.call(getDb(), sql);
    } as typeof Database.prototype.prepare;
    try {
      assert.deepEqual(await store.listOpenAttentionByConnectorInstanceIds([], { now }), new Map());
      assert.equal(membershipStatements, 0);
      const records = await store.listOpenAttentionByConnectorInstanceIds([first, second], { now });
      assert.deepEqual(
        records.get(first)?.map((record) => record.id),
        ["att_first"]
      );
      assert.equal(records.get(second), undefined, "an expired sibling cannot leak into the page evidence");
      membershipStatements = 0;
      await store.listOpenAttentionByConnectorInstanceIds([first], { now });
      const oneConnectionStatements = membershipStatements;
      membershipStatements = 0;
      await store.listOpenAttentionByConnectorInstanceIds(
        Array.from({ length: 100 }, (_, index) => `cin_attention_page_${index}`),
        { now }
      );
      assert.equal(membershipStatements, oneConnectionStatements, "a fixed 100-id page has constant attention SQL");
      membershipStatements = 0;
      await store.listOpenAttentionByConnectorInstanceIds(
        Array.from({ length: 901 }, (_, index) => `cin_attention_chunk_${index}`),
        { now }
      );
      // Statement caching can reuse the one-id SQL shape from the preceding
      // probe; this oracle asserts the durable bound rather than treating a
      // cache hit as missing database work.
      assert.ok(membershipStatements >= 1 && membershipStatements <= 2);
    } finally {
      Database.prototype.prepare = originalPrepare;
    }
  })
);

// ─── Store-level behavior ─────────────────────────────────────────────────

test(
  "attention store persists open records and lists them per connector",
  withTempDb(async () => {
    const store = createSqliteConnectorAttentionStore();
    const record = createAttention({
      action_target: "dashboard",
      connection_id: "codex",
      dedupe_key: "codex:otp",
      id: "att_otp",
      now: "2026-05-19T11:50:00.000Z",
      owner_action: "provide_value",
      progress_posture: "blocked",
      reason_code: "otp_required",
      response_contract: "response_required",
      sensitivity: "non_secret",
    });
    await store.upsertAttention({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_a",
      record,
    });

    const open = await store.listOpenAttentionForConnection({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_a",
    });
    assert.equal(open.length, 1);
    const [openRecord] = open;
    assert.ok(openRecord, "expected an open attention record");
    assert.equal(openRecord.id, "att_otp");
    assert.equal(openRecord.lifecycle, "open");
    assert.equal(openRecord.action_target, "dashboard");
  })
);

test(
  "attention store transitionAttention enforces lifecycle and hides resolved rows from open list",
  withTempDb(async () => {
    const store = createSqliteConnectorAttentionStore();
    const record = createAttention({
      connection_id: "codex",
      dedupe_key: "codex:otp",
      id: "att_close",
      now: "2026-05-19T11:50:00.000Z",
      owner_action: "provide_value",
      progress_posture: "blocked",
      reason_code: "otp_required",
      response_contract: "response_required",
      sensitivity: "non_secret",
    });
    await store.upsertAttention({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_a",
      record,
    });

    const resolved = await store.transitionAttention({
      attentionId: "att_close",
      now: "2026-05-19T11:55:00.000Z",
      to: "resolved",
    });
    assert.ok(resolved, "expected transitionAttention to return the updated record");
    assert.equal(resolved.lifecycle, "resolved");
    assert.equal(resolved.updated_at, "2026-05-19T11:55:00.000Z");

    const open = await store.listOpenAttentionForConnection({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_a",
    });
    assert.deepEqual(open, []);

    await assert.rejects(
      store.transitionAttention({ attentionId: "att_close", now: "2026-05-19T11:56:00.000Z", to: "open" }),
      REGEXP_1
    );
  })
);

test(
  "attention store suppresses expired open rows from the open list",
  withTempDb(async () => {
    const store = createSqliteConnectorAttentionStore();
    await store.upsertAttention({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_a",
      record: createAttention({
        action_target: "remote_surface",
        connection_id: "chatgpt",
        dedupe_key: "chatgpt:cin_chatgpt_a:interaction:manual_action:conversations",
        expires_at: "2026-05-19T12:00:00.000Z",
        id: "att_expired_manual_action",
        now: "2026-05-19T11:50:00.000Z",
        owner_action: "operate_attachment",
        progress_posture: "blocked",
        reason_code: "manual_action_required",
        response_contract: "response_required",
        run_id: "run_old_failed",
        sensitivity: "non_secret",
      }),
    });
    await store.upsertAttention({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_a",
      record: createAttention({
        action_target: "remote_surface",
        connection_id: "chatgpt",
        dedupe_key: "chatgpt:cin_chatgpt_a:interaction:manual_action:conversations:fresh",
        expires_at: "2099-05-19T12:00:00.000Z",
        id: "att_future_manual_action",
        now: "2026-05-19T11:55:00.000Z",
        owner_action: "operate_attachment",
        progress_posture: "blocked",
        reason_code: "manual_action_required",
        response_contract: "response_required",
        run_id: "run_current_failed",
        sensitivity: "non_secret",
      }),
    });

    const open = await store.listOpenAttentionForConnection({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_a",
    });
    assert.deepEqual(
      open.map((row) => {
        assert.ok(row, "expected a non-null attention record in the open list");
        return row.id;
      }),
      ["att_future_manual_action"]
    );
  })
);

test(
  "attention store expires due open rows in columns and record_json",
  withTempDb(async () => {
    const store = createSqliteConnectorAttentionStore();
    await store.upsertAttention({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_a",
      record: createAttention({
        action_target: "remote_surface",
        connection_id: "chatgpt",
        dedupe_key: "chatgpt:cin_chatgpt_a:interaction:manual_action:conversations",
        expires_at: "2026-05-19T12:00:00.000Z",
        id: "att_expire_due",
        now: "2026-05-19T11:50:00.000Z",
        owner_action: "operate_attachment",
        progress_posture: "blocked",
        reason_code: "manual_action_required",
        response_contract: "response_required",
        run_id: "run_old_failed",
        sensitivity: "non_secret",
      }),
    });

    const expired = await store.expireDueAttentionForConnection({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_a",
      now: "2026-05-19T12:00:01.000Z",
    });
    assert.equal(expired.length, 1);
    const [expiredRecord] = expired;
    assert.ok(expiredRecord, "expected an expired attention record");
    assert.equal(expiredRecord.lifecycle, "expired");

    const persisted = requirePersistedAttentionRow(
      getDb()
        .prepare("SELECT lifecycle, updated_at, record_json FROM connector_attention_records WHERE attention_id = ?")
        .get("att_expire_due")
    );
    assert.equal(persisted.lifecycle, "expired");
    assert.equal(persisted.updated_at, "2026-05-19T12:00:01.000Z");
    assert.equal(JSON.parse(persisted.record_json).lifecycle, "expired");
    assert.equal(JSON.parse(persisted.record_json).updated_at, "2026-05-19T12:00:01.000Z");

    const open = await store.listOpenAttentionForConnection({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_a",
    });
    assert.deepEqual(open, []);
  })
);

test(
  "attention store cancels open rows for runs that already reached terminal",
  withTempDb(async () => {
    const store = createSqliteConnectorAttentionStore();
    const trace = createTraceContext({ scenarioId: "scn_attention_terminal_reconcile" });
    await store.upsertAttention({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_a",
      record: createAttention({
        action_target: "remote_surface",
        connection_id: "chatgpt",
        dedupe_key: "chatgpt:cin_chatgpt_a:interaction:manual_action:conversations",
        expires_at: "2099-05-19T12:00:00.000Z",
        id: "att_terminal_run",
        now: "2026-05-19T11:50:00.000Z",
        owner_action: "operate_attachment",
        progress_posture: "blocked",
        reason_code: "manual_action_required",
        response_contract: "response_required",
        run_id: "run_terminal_attention",
        sensitivity: "non_secret",
      }),
    });
    await emitSpineEvent(
      {
        actor_id: "chatgpt",
        actor_type: "runtime",
        data: {
          reason: "controller_restarted",
          source: { id: "chatgpt", kind: "connector" },
        },
        event_type: "run.failed",
        object_id: "run_terminal_attention",
        object_type: "run",
        run_id: "run_terminal_attention",
        scenario_id: trace.scenario_id,
        source_id: "chatgpt",
        source_kind: "connector",
        status: "failed",
        trace_id: trace.trace_id,
      },
      getDb()
    );

    const cancelled = await store.cancelOpenAttentionForTerminalRuns({
      now: "2026-05-19T12:00:01.000Z",
    });
    assert.equal(cancelled.length, 1);
    const [cancelledRecord] = cancelled;
    assert.ok(cancelledRecord, "expected a cancelled attention record");
    assert.equal(cancelledRecord.id, "att_terminal_run");
    assert.equal(cancelledRecord.lifecycle, "cancelled");

    const persisted = requirePersistedAttentionRow(
      getDb()
        .prepare("SELECT lifecycle, updated_at, record_json FROM connector_attention_records WHERE attention_id = ?")
        .get("att_terminal_run")
    );
    assert.equal(persisted.lifecycle, "cancelled");
    assert.equal(persisted.updated_at, "2026-05-19T12:00:01.000Z");
    assert.equal(JSON.parse(persisted.record_json).lifecycle, "cancelled");

    const open = await store.listOpenAttentionForConnection({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_a",
    });
    assert.deepEqual(open, []);
  })
);

test(
  "attention projection hides due-expired rows from reads without durably reconciling them",
  withTempDb(async () => {
    // Terminal-gate revision (2026-07-29): ordinary reads must be
    // side-effect-free. getConnectorAttentionProjection (backing GET
    // /_ref/connectors) no longer calls expireDueAttentionForConnection
    // inline — it only excludes due-expired rows from the *read* via a
    // non-mutating `expires_at` predicate. The durable `lifecycle` column
    // is left exactly as-is ("open") until the periodic/startup
    // maintenance sweep (server/connector-maintenance-sweep.ts) calls
    // store.expireAllDueAttention and writes the reconciliation.
    const store = getDefaultConnectorAttentionStore();
    await store.upsertAttention({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_a",
      record: createAttention({
        action_target: "remote_surface",
        connection_id: "amazon",
        dedupe_key: "amazon:cin_amazon_a:interaction:manual_action:orders",
        expires_at: "2000-01-01T00:00:00.000Z",
        id: "att_projection_expired",
        now: "1999-12-31T23:59:00.000Z",
        owner_action: "operate_attachment",
        progress_posture: "blocked",
        reason_code: "manual_action_required",
        response_contract: "response_required",
        run_id: "run_old_failed",
        sensitivity: "non_secret",
      }),
    });

    const projection = await getConnectorAttentionProjection("amazon", {
      connectorInstanceId: "cin_amazon_a",
    });
    assert.equal(projection.unreliable, false);
    assert.deepEqual(projection.records, [], "the read hides the due-expired row without writing to it");

    const beforeSweep = requirePersistedAttentionRow(
      getDb()
        .prepare("SELECT lifecycle, record_json FROM connector_attention_records WHERE attention_id = ?")
        .get("att_projection_expired")
    );
    assert.equal(beforeSweep.lifecycle, "open", "the read path must not durably reconcile the row");
    assert.equal(JSON.parse(beforeSweep.record_json).lifecycle, "open");

    // Simulate the maintenance sweep's attention-expiry phase, which is the
    // only place this reconciliation now happens.
    const swept = await store.expireAllDueAttention({ now: "2026-05-19T12:00:00.000Z" });
    assert.deepEqual(
      swept.map((record) => record.id),
      ["att_projection_expired"]
    );

    const afterSweep = requirePersistedAttentionRow(
      getDb()
        .prepare("SELECT lifecycle, record_json FROM connector_attention_records WHERE attention_id = ?")
        .get("att_projection_expired")
    );
    assert.equal(afterSweep.lifecycle, "expired");
    assert.equal(JSON.parse(afterSweep.record_json).lifecycle, "expired");
  })
);

test(
  "attention store scopes reads by connector_instance_id",
  withTempDb(async () => {
    // Two separate enrolled instances of the same connector. One has an
    // open OTP; the other must NOT see it bleed into its open list. The
    // dashboard renders each configured connection on its own row, so
    // cross-instance leakage would let one owner's OTP push the other
    // instance into needs_attention.
    const store = createSqliteConnectorAttentionStore();
    await store.upsertAttention({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_a",
      record: createAttention({
        connection_id: "codex",
        dedupe_key: "codex:a:otp",
        id: "att_a",
        now: "2026-05-19T11:50:00.000Z",
        owner_action: "provide_value",
        progress_posture: "blocked",
        reason_code: "otp_required",
        response_contract: "response_required",
        sensitivity: "non_secret",
      }),
    });

    const otherInstance = await store.listOpenAttentionForConnection({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_b",
    });
    assert.deepEqual(otherInstance, []);

    const sameInstance = await store.listOpenAttentionForConnection({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_a",
    });
    assert.equal(sameInstance.length, 1);
    const [sameInstanceRecord] = sameInstance;
    assert.ok(sameInstanceRecord, "expected the same-instance attention record");
    assert.equal(sameInstanceRecord.id, "att_a");
  })
);

test(
  "attention store recordNotificationOutcomeById updates notification_state without touching lifecycle",
  withTempDb(async () => {
    const store = createSqliteConnectorAttentionStore();
    const record = createAttention({
      action_target: "remote_surface",
      auto_detect: false,
      connection_id: "codex",
      dedupe_key: "codex:cin_x:interaction:manual_action:conversations",
      id: "att_notify_1",
      now: "2026-05-19T12:00:00.000Z",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      reason_code: "manual_action_required",
      response_contract: "response_required",
      run_id: "run_n1",
      sensitivity: "non_secret",
    });
    await store.upsertAttention({ connectorId: "codex", connectorInstanceId: "cin_x", record });

    const sent = await store.recordNotificationOutcomeById({
      attentionId: "att_notify_1",
      now: "2026-05-19T12:01:00.000Z",
      outcome: "sent",
      reason: null,
    });
    assert.ok(sent);
    assert.equal(sent.notification_state, "sent");
    assert.equal(sent.lifecycle, "open");
    assert.equal(sent.notification_updated_at, "2026-05-19T12:01:00.000Z");

    const failed = await store.recordNotificationOutcomeById({
      attentionId: "att_notify_1",
      now: "2026-05-19T12:02:00.000Z",
      outcome: "failed",
      reason: "transport: 410 gone",
    });
    assert.ok(failed, "expected recordNotificationOutcomeById to return the updated record");
    assert.equal(failed.notification_state, "failed");
    assert.equal(failed.notification_reason, "transport: 410 gone");
    // The attention SHALL remain visible after delivery failure.
    const stillOpen = await store.listOpenAttentionForConnection({
      connectorId: "codex",
      connectorInstanceId: "cin_x",
    });
    assert.equal(stillOpen.length, 1, "failed delivery does not retire the attention row");
    const [stillOpenRecord] = stillOpen;
    assert.ok(stillOpenRecord, "expected the still-open attention record");
    assert.equal(stillOpenRecord.notification_state, "failed");
  })
);

test(
  "attention store recordNotificationOutcomeById rejects invalid outcomes",
  withTempDb(async () => {
    const store = createSqliteConnectorAttentionStore();
    const record = createAttention({
      connection_id: "codex",
      dedupe_key: "codex:cin_x:interaction:manual_action:conversations",
      id: "att_notify_invalid",
      now: "2026-05-19T12:00:00.000Z",
      owner_action: "operate_attachment",
      progress_posture: "blocked",
      reason_code: "manual_action_required",
      response_contract: "response_required",
      sensitivity: "non_secret",
    });
    await store.upsertAttention({ connectorId: "codex", connectorInstanceId: "cin_x", record });
    await assert.rejects(() =>
      store.recordNotificationOutcomeById({
        attentionId: "att_notify_invalid",
        now: "2026-05-19T12:01:00.000Z",
        outcome: "maybe",
        reason: null,
      })
    );
  })
);

test(
  "attention store recordNotificationOutcomeById returns null for unknown id",
  withTempDb(async () => {
    const store = createSqliteConnectorAttentionStore();
    const result = await store.recordNotificationOutcomeById({
      attentionId: "att_missing",
      now: "2026-05-19T12:00:00.000Z",
      outcome: "sent",
      reason: null,
    });
    assert.equal(result, null);
  })
);

test(
  "attention store upsert preserves redaction of secret-y metadata applied by runtime",
  withTempDb(async () => {
    // The runtime's `createAttention` already redacts secret-keyed metadata
    // before constructing the record. The store must round-trip whatever
    // the runtime decided — never reintroducing the original values, even
    // if the caller hands the store a record they mutated post-creation.
    const store = createSqliteConnectorAttentionStore();
    const record = createAttention({
      connection_id: "codex",
      dedupe_key: "codex:otp",
      id: "att_secret_meta",
      metadata: { note: "fine to show", otp: "123456" },
      now: "2026-05-19T11:50:00.000Z",
      owner_action: "provide_value",
      progress_posture: "blocked",
      reason_code: "otp_required",
      response_contract: "response_required",
      sensitivity: "secret",
    });
    assert.equal(record.metadata.otp, "[redacted]");

    await store.upsertAttention({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_a",
      record,
    });
    const [open] = await store.listOpenAttentionForConnection({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_a",
    });
    assert.ok(open, "expected an open attention record");
    assert.equal(open.metadata.otp, "[redacted]");
    assert.equal(open.metadata.note, "fine to show");
  })
);

// ─── Projection wiring: attention → connection health ──────────────────────

test("connection health surfaces structured attention as needs_attention with structured CTA", () => {
  const record = createAttention({
    action_target: "dashboard",
    connection_id: "codex",
    dedupe_key: "codex:otp",
    id: "att_otp",
    now: "2026-05-19T11:50:00.000Z",
    owner_action: "provide_value",
    progress_posture: "blocked",
    reason_code: "otp_required",
    response_contract: "response_required",
    sensitivity: "non_secret",
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [record],
    freshness: { captured_at: "2026-05-19T12:00:00.000Z", status: "current" },
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: "2026-05-19T12:00:00.000Z",
    schedule: null,
  });
  assert.equal(snapshot.state, "needs_attention");
  assert.equal(snapshot.next_action?.source, "structured");
  assert.equal(snapshot.next_action?.attention_id, "att_otp");
});

test("structured attention beats schedule.human_attention_needed fallback", () => {
  const record = createAttention({
    action_target: "remote_surface",
    connection_id: "codex",
    dedupe_key: "codex:verify",
    id: "att_struct",
    now: "2026-05-19T11:50:00.000Z",
    owner_action: "operate_attachment",
    progress_posture: "blocked",
    reason_code: "manual_verification",
    response_contract: "response_required",
    sensitivity: "non_secret",
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [record],
    freshness: { captured_at: "2026-05-19T12:00:00.000Z", status: "current" },
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: "2026-05-19T12:00:00.000Z",
    schedule: {
      enabled: true,
      human_attention_needed: true,
      last_error_code: "browser_runtime_not_configured",
    },
  });
  assert.equal(snapshot.state, "needs_attention");
  assert.equal(snapshot.next_action?.source, "structured");
  assert.equal(snapshot.reason_code, "manual_verification");
});

test("secret-sensitive structured attention suppresses action_target", () => {
  const record = createAttention({
    action_target: "dashboard:/secrets/codex",
    connection_id: "codex",
    dedupe_key: "codex:otp",
    id: "att_secret",
    now: "2026-05-19T11:50:00.000Z",
    owner_action: "provide_value",
    progress_posture: "blocked",
    reason_code: "otp_required",
    response_contract: "response_required",
    sensitivity: "secret",
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [record],
    freshness: { captured_at: "2026-05-19T12:00:00.000Z", status: "current" },
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: "2026-05-19T12:00:00.000Z",
    schedule: null,
  });
  assert.equal(snapshot.next_action?.action_target, null);
  assert.equal(snapshot.next_action?.attention_id, "att_secret");
});

test("resolved structured attention does not drive needs_attention", () => {
  const open = createAttention({
    connection_id: "codex",
    dedupe_key: "codex:otp",
    id: "att_resolved",
    now: "2026-05-19T11:50:00.000Z",
    owner_action: "provide_value",
    progress_posture: "blocked",
    reason_code: "otp_required",
    response_contract: "response_required",
    sensitivity: "non_secret",
  });
  const resolved = transition(open, { now: "2026-05-19T11:55:00.000Z", to: "resolved" });
  const snapshot = projectConnectorSummaryConnectionHealth({
    // Caller is expected to filter terminal records via store-side WHERE,
    // but the projection is also expected to be honest if a terminal
    // record leaks in.
    attentionRecords: [resolved],
    freshness: { captured_at: "2026-05-19T12:00:00.000Z", status: "current" },
    lastRun: succeededRun(),
    lastSuccessfulRun: succeededRun(),
    nowIso: "2026-05-19T12:00:00.000Z",
    schedule: null,
  });
  assert.equal(snapshot.state, "healthy");
  assert.equal(snapshot.next_action, null);
});

test("superseded structured attention does not drive needs_attention", () => {
  const open = createAttention({
    connection_id: "codex",
    dedupe_key: "codex:otp",
    id: "att_superseded",
    now: "2026-05-19T11:50:00.000Z",
    owner_action: "provide_value",
    progress_posture: "blocked",
    reason_code: "otp_required",
    response_contract: "response_required",
    sensitivity: "non_secret",
  });
  const superseded = transition(open, { now: "2026-05-19T11:55:00.000Z", to: "superseded" });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [superseded],
    freshness: { captured_at: "2026-05-19T12:00:00.000Z", status: "current" },
    lastRun: succeededRun(),
    lastSuccessfulRun: succeededRun(),
    nowIso: "2026-05-19T12:00:00.000Z",
    schedule: null,
  });
  assert.equal(snapshot.state, "healthy");
});

// ─── Attention-store read failure → unknown, not false healthy ─────────────

test("attention-store read failure flips snapshot to unknown via attention_store unreliable source", () => {
  // The projection takes an `unreliableSources` array. The list/detail
  // wiring must propagate `attention_store` into that array when the
  // store read throws, so the headline becomes `unknown` rather than
  // silently rendering a clean run as healthy.
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [],
    freshness: { captured_at: "2026-05-19T12:00:00.000Z", status: "current" },
    lastRun: succeededRun(),
    lastSuccessfulRun: succeededRun(),
    nowIso: "2026-05-19T12:00:00.000Z",
    schedule: null,
    unreliableSources: ["attention_store"],
  });
  assert.equal(snapshot.state, "unknown");
  assert.deepEqual(snapshot.unknown_reasons, ["attention_store"]);
});

// ─── End-to-end: store + helper + projection ───────────────────────────────

test(
  "getConnectorAttentionProjection reads durable rows for use in connector summary",
  withTempDb(async () => {
    const store = getDefaultConnectorAttentionStore();
    const instanceId = "cin_codex_a";
    await store.upsertAttention({
      connectorId: "codex",
      connectorInstanceId: instanceId,
      record: createAttention({
        action_target: "dashboard",
        connection_id: "codex",
        dedupe_key: "codex:otp",
        id: "att_live",
        now: "2026-05-19T11:50:00.000Z",
        owner_action: "provide_value",
        progress_posture: "blocked",
        reason_code: "otp_required",
        response_contract: "response_required",
        sensitivity: "non_secret",
      }),
    });

    const projection = await getConnectorAttentionProjection("codex", {
      connectorInstanceId: instanceId,
    });
    assert.equal(projection.unreliable, false);
    assert.equal(projection.records.length, 1);

    const snapshot = projectConnectorSummaryConnectionHealth({
      attentionRecords: projection.records,
      freshness: { captured_at: "2026-05-19T12:00:00.000Z", status: "current" },
      lastRun: failedRun(),
      lastSuccessfulRun: null,
      nowIso: "2026-05-19T12:00:00.000Z",
      schedule: null,
    });
    assert.equal(snapshot.state, "needs_attention");
    assert.equal(snapshot.next_action?.source, "structured");
    assert.equal(snapshot.next_action?.attention_id, "att_live");
  })
);

test(
  "expired stale manual action does not override a later successful run projection",
  withTempDb(async () => {
    const store = getDefaultConnectorAttentionStore();
    await store.upsertAttention({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_a",
      record: createAttention({
        action_target: "remote_surface",
        connection_id: "chatgpt",
        dedupe_key: "chatgpt:cin_chatgpt_a:interaction:manual_action:conversations",
        expires_at: "2026-05-19T12:00:00.000Z",
        id: "att_old_chatgpt_manual_action",
        now: "2026-05-19T11:50:00.000Z",
        owner_action: "operate_attachment",
        progress_posture: "blocked",
        reason_code: "manual_action_required",
        response_contract: "response_required",
        run_id: "run_old_failed",
        sensitivity: "non_secret",
      }),
    });

    const projection = await getConnectorAttentionProjection("chatgpt", {
      connectorInstanceId: "cin_chatgpt_a",
    });
    assert.equal(projection.unreliable, false);
    assert.deepEqual(projection.records, []);

    const success = succeededRun({
      finished_at: "2026-05-19T12:11:00.000Z",
      first_at: "2026-05-19T12:10:00.000Z",
      last_at: "2026-05-19T12:11:00.000Z",
      run_id: "run_later_ok",
      started_at: "2026-05-19T12:10:00.000Z",
    });
    const snapshot = projectConnectorSummaryConnectionHealth({
      attentionRecords: projection.records,
      freshness: { captured_at: "2026-05-19T12:11:00.000Z", status: "current" },
      lastRun: success,
      lastSuccessfulRun: success,
      nowIso: "2026-05-19T12:11:00.000Z",
      schedule: null,
    });
    assert.equal(snapshot.state, "healthy");
    assert.equal(snapshot.next_action, null);
  })
);

test(
  "getConnectorAttentionProjection isolates connector instances",
  withTempDb(async () => {
    const store = getDefaultConnectorAttentionStore();
    await store.upsertAttention({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_a",
      record: createAttention({
        connection_id: "codex",
        dedupe_key: "codex:a:otp",
        id: "att_a_only",
        now: "2026-05-19T11:50:00.000Z",
        owner_action: "provide_value",
        progress_posture: "blocked",
        reason_code: "otp_required",
        response_contract: "response_required",
        sensitivity: "non_secret",
      }),
    });

    const a = await getConnectorAttentionProjection("codex", { connectorInstanceId: "cin_codex_a" });
    const b = await getConnectorAttentionProjection("codex", { connectorInstanceId: "cin_codex_b" });

    assert.equal(a.records.length, 1);
    assert.equal(b.records.length, 0);
  })
);

test(
  "getConnectorAttentionProjection surfaces unreliable when store throws",
  withTempDb(async () => {
    // We exercise the catch path by closing the DB underneath the store
    // before the projection runs. The helper must NOT throw; it must
    // return `unreliable: true` so the projection becomes `unknown`
    // rather than silently false-green.
    closeDb();
    resetDefaultConnectorAttentionStoreCache();
    const projection = await getConnectorAttentionProjection("codex");
    assert.equal(projection.unreliable, true);
    assert.equal(projection.records.length, 0);

    const snapshot = projectConnectorSummaryConnectionHealth({
      attentionRecords: projection.records,
      freshness: { captured_at: "2026-05-19T12:00:00.000Z", status: "current" },
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: "2026-05-19T12:00:00.000Z",
      schedule: null,
      unreliableSources: projection.unreliable ? ["attention_store"] : [],
    });
    assert.equal(snapshot.state, "unknown");
    assert.deepEqual(snapshot.unknown_reasons, ["attention_store"]);
    // initDb expected by withTempDb's finally — reopen so closeDb cleans up cleanly.
    // The withTempDb helper relies on closeDb being safe to call after an
    // already-closed handle; better-sqlite3 tolerates double-close.
  })
);

if (POSTGRES_URL) {
  test("attention page batch preserves SQLite-visible exact-instance and expiry semantics on Postgres", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const first = `cin_attention_pg_first_${suffix}`;
    const second = `cin_attention_pg_second_${suffix}`;
    const now = "2026-05-19T12:00:00.000Z";
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      const store = createPostgresConnectorAttentionStore();
      await store.upsertAttention({
        connectorId: `attention_pg_${suffix}`,
        connectorInstanceId: first,
        record: createAttention({
          action_target: "dashboard",
          connection_id: "attention_pg",
          dedupe_key: `first_${suffix}`,
          id: `att_first_${suffix}`,
          now: "2026-05-19T11:50:00.000Z",
          owner_action: "provide_value",
          progress_posture: "blocked",
          reason_code: "otp_required",
          response_contract: "response_required",
          sensitivity: "non_secret",
        }),
      });
      await store.upsertAttention({
        connectorId: `attention_pg_${suffix}`,
        connectorInstanceId: second,
        record: createAttention({
          action_target: "dashboard",
          connection_id: "attention_pg",
          dedupe_key: `expired_${suffix}`,
          expires_at: "2026-05-19T11:59:00.000Z",
          id: `att_expired_${suffix}`,
          now: "2026-05-19T11:50:00.000Z",
          owner_action: "provide_value",
          progress_posture: "blocked",
          reason_code: "otp_required",
          response_contract: "response_required",
          sensitivity: "non_secret",
        }),
      });
      const rows = await store.listOpenAttentionByConnectorInstanceIds([first, second], { now });
      assert.deepEqual(
        rows.get(first)?.map((record) => record.id),
        [`att_first_${suffix}`]
      );
      assert.equal(rows.get(second), undefined);
    } finally {
      await postgresQuery("DELETE FROM connector_attention_records WHERE connector_instance_id = ANY($1::text[])", [
        [first, second],
      ]);
      await closePostgresStorage();
      closeDb();
    }
  });
}
