// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the connector configuration spine's core safety properties:
 *
 *   1. "Who chose that list?" must always be answerable by a query, and an
 *      unattributed write must not be representable.
 *   2. A well-typed, fully-attributed AGENT write must not itself become
 *      the connection's active configuration when it shapes collection
 *      scope -- only authenticated confirmation by the connection owner may
 *      activate it. This
 *      is the correction from the adversarial design review
 *      (~/.tmp/reorg-0814/CONFIG-REDTEAM-CODEX.md) of an earlier draft
 *      that stored mutable current-state and therefore let a
 *      well-typed agent write pass as if owner-chosen.
 *   3. An inherited default is distinguishable from an explicit choice.
 *
 * See server/stores/connector-instance-config-store.ts for the full
 * design rationale (the 239-Slack-channel-ID incident this exists to fix).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  type ConfigProvenance,
  ConfigStaleWriteError,
  createSqliteConnectorInstanceConfigStore,
} from "../server/stores/connector-instance-config-store.ts";

const NOW = "2026-08-22T13:41:00.000Z";
const LATER = "2026-08-22T14:00:00.000Z";

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
     ) VALUES (?, 'owner-1', ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
  ).run(connectorInstanceId, connectorId, connectorInstanceId, connectorInstanceId, NOW, NOW);
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

/**
 * Simulates an untrusted caller's obsolete `optionKind` claim without making
 * that claim part of the test contract. The store must derive the persisted
 * kind from the registered connector option keys instead.
 */
function withCallerOptionKindClaim(
  provenance: Omit<ConfigProvenance, "optionKind">,
  optionKind: "collection_scope" | "transport"
): ConfigProvenance {
  return { ...provenance, optionKind } as ConfigProvenance;
}

const OWNER_PROVENANCE = withCallerOptionKindClaim(
  {
    origin: "owner",
    isExplicit: true,
    sourceOfChange: "console: owner clicked 'archive all channels'",
    setBy: "owner",
    setAt: NOW,
  },
  "collection_scope"
);

const AGENT_239_IDS = Array.from({ length: 239 }, (_, i) => `C${i}`);

test(
  "propose() keeps an owner-origin collection revision proposed until authenticated confirmation",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const revision = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { CHANNEL_ALLOWLIST: ["C01", "C02"] },
      provenance: OWNER_PROVENANCE,
      baseRevision: 0,
      baseEpoch: 1,
    });

    // Origin records who supplied the value; it is not authorization. A
    // separate authenticated owner confirmation is required to activate it.
    assert.equal(revision.status, "proposed");
    assert.deepEqual(revision.config, { CHANNEL_ALLOWLIST: ["C01", "C02"] });
    assert.equal(revision.origin, "owner");
    assert.equal(revision.setBy, "owner");
    assert.equal(revision.sourceOfChange, "console: owner clicked 'archive all channels'");

    const active = await store.getActiveRevision("cin_slack_1");
    assert.equal(active, null);
  })
);

test(
  "a caller cannot self-activate CHANNEL_ALLOWLIST by claiming transport",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const revision = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { CHANNEL_ALLOWLIST: ["C01"] },
      provenance: withCallerOptionKindClaim({ ...OWNER_PROVENANCE }, "transport"),
      baseRevision: 0,
      baseEpoch: 1,
    });

    assert.equal(revision.optionKind, "collection_scope", "CHANNEL_ALLOWLIST is platform-classified collection scope");
    assert.equal(revision.status, "proposed", "a forged transport claim must not self-activate collection scope");
    assert.equal(await store.getActiveRevision("cin_slack_1"), null);
  })
);

test(
  "a mixed bundle is collection_scope when any registered option shapes collection",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const revision = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { CHANNEL_ALLOWLIST: ["C01"], SKIP_FILES: true },
      provenance: withCallerOptionKindClaim({ ...OWNER_PROVENANCE }, "transport"),
      baseRevision: 0,
      baseEpoch: 1,
    });

    assert.equal(revision.optionKind, "collection_scope");
    assert.equal(revision.status, "proposed");
  })
);

test(
  "ACCEPTANCE ATTACK 1 (red-team): an agent submitting 239 Slack IDs lands only as a pending proposal -- no run may consume it before owner confirmation",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const proposed = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { CHANNEL_ALLOWLIST: AGENT_239_IDS },
      provenance: withCallerOptionKindClaim({
        origin: "agent",
        isExplicit: true,
        sourceOfChange:
          "bounded Slack archive run requested 2026-08-22; agent computed archived-and-not-a-member set",
        setBy: "agent-18",
        setAt: NOW,
      }, "collection_scope"),
      baseRevision: 0,
      baseEpoch: 1,
    });

    assert.equal(proposed.status, "proposed", "a collection_scope write must never self-activate");
    assert.equal(proposed.origin, "agent", "must not be laundered as owner-chosen");
    assert.equal((proposed.config.CHANNEL_ALLOWLIST as string[]).length, 239);

    // The load-bearing assertion: a run resolver reads getActiveRevision(),
    // and it must see nothing from this proposal.
    const active = await store.getActiveRevision("cin_slack_1");
    assert.equal(active, null, "no run may consume the agent's proposal before the owner confirms it");
  })
);

test(
  "owner confirmation activates a proposed revision and supersedes the prior active one",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const proposed = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { CHANNEL_ALLOWLIST: AGENT_239_IDS },
      provenance: withCallerOptionKindClaim({
        origin: "agent",
        isExplicit: true,
        sourceOfChange: "bounded Slack archive run requested 2026-08-22",
        setBy: "agent-18",
        setAt: NOW,
      }, "collection_scope"),
      baseRevision: 0,
      baseEpoch: 1,
    });
    assert.equal(await store.getActiveRevision("cin_slack_1"), null);

    const confirmed = await store.confirm({
      connectorInstanceId: "cin_slack_1",
      revision: proposed.revision,
      confirmedAt: LATER,
      authenticatedOwnerSubjectId: "owner-1",
    });
    assert.equal(confirmed.status, "active");
    assert.equal(confirmed.confirmedBy, "owner-1");
    assert.equal(confirmed.confirmedAt, LATER);
    // Attribution of WHO PROPOSED the value is preserved even after
    // owner confirmation -- confirming is not the same as re-authoring.
    assert.equal(confirmed.origin, "agent", "confirmation must not rewrite the original author");

    const active = await store.getActiveRevision("cin_slack_1");
    assert.equal(active?.revision, proposed.revision);
  })
);

test(
  "a transport-only revision self-activates -- there is nothing collection-shaping for the owner to confirm",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const revision = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { SKIP_FILES: true },
      provenance: withCallerOptionKindClaim({
        origin: "agent",
        isExplicit: true,
        sourceOfChange: "agent tuned pagination for throughput",
        setBy: "agent-18",
        setAt: NOW,
      }, "transport"),
      baseRevision: 0,
      baseEpoch: 1,
    });
    assert.equal(revision.status, "active", "transport tuning cannot change what is collected, so it self-activates");
  })
);

test(
  "confirm() rejects a free-form confirmation that lacks the authenticated owner subject",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const proposed = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { CHANNEL_ALLOWLIST: ["C01"] },
      provenance: OWNER_PROVENANCE,
      baseRevision: 0,
      baseEpoch: 1,
    });

    await assert.rejects(
      () =>
        store.confirm({
          connectorInstanceId: "cin_slack_1",
          revision: proposed.revision,
          confirmedBy: "owner",
          confirmedAt: LATER,
        } as unknown as Parameters<typeof store.confirm>[0]),
      /authenticated owner subject/i
    );
  })
);

test(
  "an authenticated subject cannot confirm a connection owned by someone else",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const proposed = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { CHANNEL_ALLOWLIST: ["C01"] },
      provenance: OWNER_PROVENANCE,
      baseRevision: 0,
      baseEpoch: 1,
    });

    await assert.rejects(
      () =>
        store.confirm({
          connectorInstanceId: "cin_slack_1",
          revision: proposed.revision,
          confirmedAt: LATER,
          authenticatedOwnerSubjectId: "owner-2",
        }),
      /authenticated owner subject does not own/
    );
    assert.equal(await store.getActiveRevision("cin_slack_1"), null);
  })
);

test(
  "getActiveRevision ignores a malformed pointer to a proposed revision",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const proposed = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { CHANNEL_ALLOWLIST: ["C01"] },
      provenance: OWNER_PROVENANCE,
      baseRevision: 0,
      baseEpoch: 1,
    });
    getDb()
      .prepare(
        "INSERT INTO connector_instance_config_current(connector_instance_id, active_revision, storage_epoch, updated_at) VALUES (?, ?, ?, ?)"
      )
      .run("cin_slack_1", proposed.revision, 1, NOW);

    assert.equal(await store.getActiveRevision("cin_slack_1"), null);
  })
);

test(
  "MUTATION PROOF 1: a value cannot be written without attribution -- omitting a required provenance field is a type error, and a runtime bypass with an empty field is rejected",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();

    await assert.rejects(
      () =>
        store.propose({
          connectorInstanceId: "cin_slack_1",
          config: { CHANNEL_ALLOWLIST: ["C01"] },
          provenance: { ...OWNER_PROVENANCE, setBy: "" },
          baseRevision: 0,
          baseEpoch: 1,
        }),
      /setBy must not be empty/
    );

    await assert.rejects(
      () =>
        store.propose({
          connectorInstanceId: "cin_slack_1",
          config: { CHANNEL_ALLOWLIST: ["C01"] },
          provenance: { ...OWNER_PROVENANCE, sourceOfChange: "" },
          baseRevision: 0,
          baseEpoch: 1,
        }),
      /sourceOfChange must not be empty/
    );

    // Confirm nothing landed from either rejected attempt.
    const pointer = await store.getCurrentPointer("cin_slack_1");
    assert.equal(pointer, null, "a rejected unattributed write must not persist any revision or pointer");
  })
);

test(
  "MUTATION PROOF 1b (schema-level): the database itself refuses an origin outside the closed enum -- there is no 'unknown' escape hatch",
  withDb(() => {
    seedConnectorInstance("cin_slack_1");
    const db = getDb();
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO connector_instance_config_revisions(
               connector_instance_id, revision, config_json, config_contract_id, config_contract_version,
               option_kind, origin, is_explicit, status, source_of_change, set_by, set_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run("cin_slack_1", 1, "{}", "pdpp.connector_config.v1", 1, "collection_scope", "unknown", 1, "active", "x", "x", NOW),
      /CHECK constraint failed/,
      "origin='unknown' must violate the CHECK constraint even via raw SQL"
    );
  })
);

test(
  "MUTATION PROOF 2: an inherited default is distinguishable from an explicit choice, and collection defaults require confirmation",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();

    const inherited = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { MEMBER_ONLY: true },
      provenance: withCallerOptionKindClaim({
        origin: "default",
        isExplicit: false,
        sourceOfChange: "manifest-declared default applied at connection creation (no explicit choice made)",
        setBy: "system:manifest-default",
        setAt: NOW,
      }, "collection_scope"),
      baseRevision: 0,
      baseEpoch: 1,
    });
    assert.equal(inherited.isExplicit, false);
    assert.equal(inherited.status, "proposed", "a collection default must not activate without owner confirmation");
    assert.equal(await store.getActiveRevision("cin_slack_1"), null);

    const activatedDefault = await store.confirm({
      connectorInstanceId: "cin_slack_1",
      revision: inherited.revision,
      confirmedAt: LATER,
      authenticatedOwnerSubjectId: "owner-1",
    });

    const explicit = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { MEMBER_ONLY: false },
      provenance: withCallerOptionKindClaim({
        origin: "owner",
        isExplicit: true,
        sourceOfChange: "console: owner unchecked 'members only'",
        setBy: "owner",
        setAt: LATER,
      }, "collection_scope"),
      baseRevision: activatedDefault.revision,
      baseEpoch: 1,
    });
    assert.equal(explicit.isExplicit, true, "must be distinguishable from the prior inherited default");
    assert.equal(explicit.origin, "owner");
    assert.deepEqual(explicit.config, { MEMBER_ONLY: false });

    const activatedExplicit = await store.confirm({
      connectorInstanceId: "cin_slack_1",
      revision: explicit.revision,
      confirmedAt: LATER,
      authenticatedOwnerSubjectId: "owner-1",
    });

    const active = await store.getActiveRevision("cin_slack_1");
    assert.equal(active?.revision, activatedExplicit.revision);
  })
);

test(
  "ACCEPTANCE ATTACK 6 (red-team): two writers against the same base -- exactly one commits, the other gets a stale-write rejection, never a silent merge",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { SKIP_FILES: true },
      provenance: withCallerOptionKindClaim({ ...OWNER_PROVENANCE }, "transport"),
      baseRevision: 0,
      baseEpoch: 1,
    });

    // Both writers believe revision 0 (no config yet) is current.
    await assert.rejects(
      () =>
        store.propose({
          connectorInstanceId: "cin_slack_1",
          config: { SKIP_FILES: false },
          provenance: withCallerOptionKindClaim({ ...OWNER_PROVENANCE, setBy: "owner-device-2" }, "transport"),
          baseRevision: 0,
          baseEpoch: 1,
        }),
      ConfigStaleWriteError
    );

    const active = await store.getActiveRevision("cin_slack_1");
    assert.deepEqual(active?.config, { SKIP_FILES: true }, "the first writer's value must not be overwritten by the rejected second write");
  })
);

test(
  "listRevisions returns every revision for an instance, newest first, bounded",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    const first = await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { SKIP_FILES: true },
      provenance: withCallerOptionKindClaim({ ...OWNER_PROVENANCE }, "transport"),
      baseRevision: 0,
      baseEpoch: 1,
    });
    await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { SKIP_FILES: false },
      provenance: withCallerOptionKindClaim({ ...OWNER_PROVENANCE, setAt: LATER }, "transport"),
      baseRevision: first.revision,
      baseEpoch: 1,
    });

    const revisions = await store.listRevisions("cin_slack_1");
    assert.deepEqual(
      revisions.map((r) => r.revision),
      [2, 1]
    );
    assert.equal(revisions[0]?.status, "active");
    assert.equal(revisions[1]?.status, "superseded", "the prior active revision must be marked superseded, not deleted");
  })
);

test(
  "deleting the connector instance cascades and removes its config revisions and pointer",
  withDb(async () => {
    seedConnectorInstance("cin_slack_1");
    const store = createSqliteConnectorInstanceConfigStore();
    await store.propose({
      connectorInstanceId: "cin_slack_1",
      config: { CHANNEL_ALLOWLIST: ["C01"] },
      provenance: OWNER_PROVENANCE,
      baseRevision: 0,
      baseEpoch: 1,
    });

    getDb().prepare("DELETE FROM connector_instances WHERE connector_instance_id = ?").run("cin_slack_1");

    const pointer = await store.getCurrentPointer("cin_slack_1");
    assert.equal(pointer, null);
    const revisions = await store.listRevisions("cin_slack_1");
    assert.deepEqual(revisions, []);
  })
);
