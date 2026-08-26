// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the READ half of the connector-config spine: what a RUN is allowed
 * to collect against.
 *
 * The store (server/stores/connector-instance-config-store.ts) already proves
 * that a collection_scope revision lands `proposed` and needs authenticated
 * owner confirmation. That is only half the guarantee. Until something on the
 * run path actually consults the store, "proposed" and "active" are equally
 * inert -- the safety property is unobservable because nothing reads either.
 *
 * These tests close that half: they drive the real SQLite store through
 * propose/confirm and assert what `resolveRunConnectorOptions` -- the single
 * function the runtime calls at START assembly -- hands to a run.
 *
 * The load-bearing case is "a proposed revision must never reach a run."
 */

import assert from "node:assert/strict";
import test from "node:test";

import { type RunConfigDecision, resolveRunConnectorOptions } from "../server/connector-run-config.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  type ConfigProvenance,
  createSqliteConnectorInstanceConfigStore,
} from "../server/stores/connector-instance-config-store.ts";

const NOW = "2026-08-23T10:00:00.000Z";
const OWNER_SUBJECT_ID = "owner-1";

function seedConnectorInstance(connectorInstanceId: string, connectorId = "slack") {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)").run(
    connectorId,
    JSON.stringify({ connector_id: connectorId }),
    NOW
  );
  db.prepare(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  ).run(connectorInstanceId, OWNER_SUBJECT_ID, connectorId, connectorInstanceId, connectorInstanceId, NOW, NOW);
}

function withDb(fn: () => Promise<void> | void) {
  return async () => {
    initDb(":memory:");
    try {
      await fn();
    } finally {
      closeDb();
    }
  };
}

const AGENT_PROVENANCE: ConfigProvenance = {
  isExplicit: true,
  origin: "agent",
  setAt: NOW,
  setBy: "agent-session-7",
  sourceOfChange: "agent proposed a Slack channel allowlist",
};

// ─── The load-bearing case ──────────────────────────────────────────────────

test(
  "ACCEPTANCE: a PROPOSED collection_scope revision must NEVER reach a run",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();

    const proposed = await store.propose({
      baseEpoch: 1,
      baseRevision: 0,
      config: { CHANNEL_ALLOWLIST: ["C_SECRET_1", "C_SECRET_2"] },
      connectorInstanceId: "cin_slack_1",
      provenance: AGENT_PROVENANCE,
    });
    // Precondition: the store did what it promises -- this is unconfirmed.
    assert.equal(proposed.status, "proposed");
    assert.equal(proposed.optionKind, "collection_scope");

    const decisions: RunConfigDecision[] = [];
    const resolved = await resolveRunConnectorOptions({
      connectorInstanceId: "cin_slack_1",
      onDecision: (decision) => decisions.push(decision),
      store,
    });

    // The actual guarantee: a run started right now collects against manifest
    // defaults, NOT against the unconfirmed allowlist.
    assert.equal(resolved, null, "an unconfirmed revision must not become a run's configuration");
    assert.deepEqual(decisions, [{ connectorInstanceId: "cin_slack_1", reason: "no_active_revision" }]);
  })
);

test(
  "MUTATION PROOF: the proposed-must-not-apply test is not vacuous -- confirming the SAME revision does apply it",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();

    const proposed = await store.propose({
      baseEpoch: 1,
      baseRevision: 0,
      config: { CHANNEL_ALLOWLIST: ["C_SECRET_1", "C_SECRET_2"] },
      connectorInstanceId: "cin_slack_1",
      provenance: AGENT_PROVENANCE,
    });
    assert.equal(await resolveRunConnectorOptions({ connectorInstanceId: "cin_slack_1", store }), null);

    // Exact same revision, exact same config -- the ONLY thing that changed is
    // authenticated owner confirmation. If the previous assertion passed for
    // any reason other than status, this one would fail.
    await store.confirm({
      authenticatedOwnerSubjectId: OWNER_SUBJECT_ID,
      confirmedAt: NOW,
      connectorInstanceId: "cin_slack_1",
      revision: proposed.revision,
    });

    const decisions: RunConfigDecision[] = [];
    const resolved = await resolveRunConnectorOptions({
      connectorInstanceId: "cin_slack_1",
      onDecision: (decision) => decisions.push(decision),
      store,
    });
    assert.deepEqual(resolved, { CHANNEL_ALLOWLIST: ["C_SECRET_1", "C_SECRET_2"] });
    assert.deepEqual(decisions, [
      {
        connectorInstanceId: "cin_slack_1",
        optionKind: "collection_scope",
        reason: "active_revision_applied",
        revision: proposed.revision,
      },
    ]);
  })
);

test(
  "a newer PROPOSED revision does not displace the currently ACTIVE one",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();

    const first = await store.propose({
      baseEpoch: 1,
      baseRevision: 0,
      config: { CHANNEL_ALLOWLIST: ["C_OWNER_CHOSE"] },
      connectorInstanceId: "cin_slack_1",
      provenance: AGENT_PROVENANCE,
    });
    await store.confirm({
      authenticatedOwnerSubjectId: OWNER_SUBJECT_ID,
      confirmedAt: NOW,
      connectorInstanceId: "cin_slack_1",
      revision: first.revision,
    });

    // An agent now proposes a WIDER allowlist against the current base.
    const widened = await store.propose({
      baseEpoch: 1,
      baseRevision: first.revision,
      config: { CHANNEL_ALLOWLIST: ["C_OWNER_CHOSE", "C_AGENT_ADDED", "C_AGENT_ADDED_2"] },
      connectorInstanceId: "cin_slack_1",
      provenance: AGENT_PROVENANCE,
    });
    assert.equal(widened.status, "proposed");

    // A run started between the propose and any confirmation still collects
    // the owner's narrower boundary.
    const resolved = await resolveRunConnectorOptions({ connectorInstanceId: "cin_slack_1", store });
    assert.deepEqual(resolved, { CHANNEL_ALLOWLIST: ["C_OWNER_CHOSE"] });
  })
);

// ─── Transport / defaults / fail-closed ─────────────────────────────────────

test(
  "a platform-classified TRANSPORT revision self-activates and reaches a run without confirmation",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const revision = await store.propose({
      baseEpoch: 1,
      baseRevision: 0,
      config: { RECLAIM_UPLOADS: true, SKIP_FILES: false },
      connectorInstanceId: "cin_slack_1",
      provenance: AGENT_PROVENANCE,
    });
    assert.equal(revision.status, "active", "transport has nothing collection-shaping for the owner to confirm");

    const resolved = await resolveRunConnectorOptions({ connectorInstanceId: "cin_slack_1", store });
    assert.deepEqual(resolved, { RECLAIM_UPLOADS: true, SKIP_FILES: false });
  })
);

test(
  "a connection with no revisions resolves to null so the connector uses manifest defaults",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const decisions: RunConfigDecision[] = [];
    const resolved = await resolveRunConnectorOptions({
      connectorInstanceId: "cin_slack_1",
      onDecision: (decision) => decisions.push(decision),
      store,
    });
    assert.equal(resolved, null);
    assert.deepEqual(decisions, [{ connectorInstanceId: "cin_slack_1", reason: "no_active_revision" }]);
  })
);

test("a missing connector instance id resolves to null without touching the store", async () => {
  let touched = false;
  const resolved = await resolveRunConnectorOptions({
    connectorInstanceId: null,
    store: {
      getActiveRevision: () => {
        touched = true;
        return Promise.resolve(null);
      },
    },
  });
  assert.equal(resolved, null);
  assert.equal(touched, false, "no instance id means there is nothing to look up");
});

test("an unreadable store FAILS CLOSED to null rather than to a last-known-good config", async () => {
  const decisions: RunConfigDecision[] = [];
  const resolved = await resolveRunConnectorOptions({
    connectorInstanceId: "cin_slack_1",
    onDecision: (decision) => decisions.push(decision),
    store: {
      getActiveRevision: () => Promise.reject(new Error("database is locked")),
    },
  });
  assert.equal(resolved, null, "a store that cannot be read has not proven the owner confirmed anything");
  assert.deepEqual(decisions, [{ connectorInstanceId: "cin_slack_1", reason: "store_unreadable" }]);
});

test("a confirmed EMPTY config is distinguishable from having no configuration at all", async () => {
  const resolved = await resolveRunConnectorOptions({
    connectorInstanceId: "cin_slack_1",
    store: {
      getActiveRevision: () =>
        Promise.resolve({
          collectionBoundaryFingerprint: null,
          config: {},
          configContractId: "pdpp.connector_config.v1",
          configContractVersion: 1,
          confirmedAt: NOW,
          confirmedBy: OWNER_SUBJECT_ID,
          connectorInstanceId: "cin_slack_1",
          isExplicit: true,
          optionKind: "collection_scope" as const,
          origin: "owner" as const,
          revision: 3,
          setAt: NOW,
          setBy: OWNER_SUBJECT_ID,
          sourceOfChange: "owner cleared the allowlist",
          status: "active" as const,
        }),
    },
  });
  // `{}` (owner confirmed an empty config) must not collapse into `null`
  // (no configuration exists) -- they mean different things to readOptions.
  assert.deepEqual(resolved, {});
  assert.notEqual(resolved, null);
});
