// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  admitOwnerBrowserEnrollmentRunConnection,
  admitOwnerRunConnection,
  ConnectorInstanceResolutionError,
  createSqliteConnectorInstanceStore,
  resolveOwnerConnectorInstanceNamespace,
} from "../server/stores/connector-instance-store.ts";

// Focused coverage for the `draft` connector-instance status that closes the
// first-static-secret-connection deadlock without a phantom active row.
// See add-static-secret-owner-session-connect-path design Decisions 1-3, 5.

const NOW = "2026-06-02T12:00:00.000Z";
const LATER = "2026-06-02T12:05:00.000Z";

/** The store shape returned by `createSqliteConnectorInstanceStore`; its
 * record/instance types are module-private, so this is derived structurally
 * rather than imported by name. */
type ConnectorInstanceStore = ReturnType<typeof createSqliteConnectorInstanceStore>;

function seedConnector(connectorId: string) {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
}

function makeDraft(
  store: ConnectorInstanceStore,
  {
    ownerSubjectId = "owner_1",
    connectorId = "gmail",
    sourceBindingKey,
    displayName = "Gmail",
  }: { ownerSubjectId?: string; connectorId?: string; sourceBindingKey: string; displayName?: string }
) {
  return store.upsert({
    connectorId,
    createdAt: NOW,
    displayName,
    ownerSubjectId,
    sourceBinding: { kind: "static_secret_draft", nonce: sourceBindingKey },
    sourceBindingKey,
    sourceKind: "account",
    status: "draft",
    updatedAt: NOW,
  });
}

test("draft status is admitted by the SQLite store and CHECK constraint", () => {
  initDb();
  try {
    seedConnector("gmail");
    const store = createSqliteConnectorInstanceStore();
    const draft = makeDraft(store, { sourceBindingKey: "nonce_a" });
    assert.ok(draft, "upsert returned the new draft row");
    assert.equal(draft.status, "draft");
    // round-trips through get
    const roundTripped = store.get(draft.connectorInstanceId);
    assert.ok(roundTripped, "get resolves the just-inserted draft");
    assert.equal(roundTripped.status, "draft");
  } finally {
    closeDb();
  }
});

test("draft instances are invisible to listByOwner (every connection read surface)", () => {
  initDb();
  try {
    seedConnector("gmail");
    const store = createSqliteConnectorInstanceStore();
    // one active, one draft
    const active = store.upsert({
      connectorId: "gmail",
      createdAt: NOW,
      displayName: "Gmail Active",
      ownerSubjectId: "owner_1",
      sourceBinding: { kind: "account" },
      sourceBindingKey: "active_binding",
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });
    assert.ok(active, "upsert returned the new active row");
    const draft = makeDraft(store, { sourceBindingKey: "draft_binding" });
    assert.ok(draft, "upsert returned the new draft row");

    const listed = store.listByOwner("owner_1");
    const ids = listed.map((i) => i.connectorInstanceId);
    assert.ok(ids.includes(active.connectorInstanceId), "active connection is listed");
    assert.ok(!ids.includes(draft.connectorInstanceId), "draft connection is hidden from listByOwner");

    // owner-internal lookups still resolve the draft
    const roundTripped = store.get(draft.connectorInstanceId);
    assert.ok(roundTripped, "get resolves the draft");
    assert.equal(roundTripped.status, "draft");
    const byBinding = store.getByBinding({
      connectorId: "gmail",
      ownerSubjectId: "owner_1",
      sourceBindingKey: "draft_binding",
      sourceKind: "account",
    });
    assert.ok(byBinding, "getByBinding resolves the draft");
    assert.equal(byBinding.connectorInstanceId, draft.connectorInstanceId);
  } finally {
    closeDb();
  }
});

test("resolver rejects a draft by default and admits it only with allowStatuses", async () => {
  initDb();
  try {
    seedConnector("gmail");
    const store = createSqliteConnectorInstanceStore();
    const draft = makeDraft(store, { sourceBindingKey: "nonce_resolve" });
    assert.ok(draft, "upsert returned the new draft row");

    // default (active-only) → connector_instance_inactive
    await assert.rejects(
      () =>
        resolveOwnerConnectorInstanceNamespace({
          connectorInstanceId: draft.connectorInstanceId,
          connectorInstanceStore: store,
          ownerSubjectId: "owner_1",
        }),
      (err) => err instanceof ConnectorInstanceResolutionError && err.code === "connector_instance_inactive"
    );

    // explicit allowStatuses admits the draft
    const ns = await resolveOwnerConnectorInstanceNamespace({
      allowStatuses: ["active", "draft"],
      connectorInstanceId: draft.connectorInstanceId,
      connectorInstanceStore: store,
      ownerSubjectId: "owner_1",
    });
    assert.equal(ns.connectorInstanceId, draft.connectorInstanceId);
    assert.equal(ns.status, "draft");
  } finally {
    closeDb();
  }
});

test("browser enrollment admission accepts only an exact owner-owned shell draft", async () => {
  initDb();
  try {
    seedConnector("amazon");
    const store = createSqliteConnectorInstanceStore();
    const shell = store.upsert({
      connectorId: "amazon",
      createdAt: NOW,
      displayName: "Amazon",
      ownerSubjectId: "owner_1",
      sourceBinding: { enrollment_expires_at: "2026-06-02T14:00:00.000Z", kind: "browser_enrollment_shell" },
      sourceBindingKey: "browser_shell_admission",
      sourceKind: "account",
      status: "draft",
      updatedAt: NOW,
    });
    assert.ok(shell, "upsert returned the shell draft");

    const admitted = await admitOwnerBrowserEnrollmentRunConnection({
      connectorId: "amazon",
      connectorInstanceId: shell.connectorInstanceId,
      connectorInstanceStore: store,
      ownerSubjectId: "owner_1",
    });
    assert.equal(admitted.connectorInstanceId, shell.connectorInstanceId);
    assert.equal(admitted.status, "draft");

    await assert.rejects(
      () =>
        admitOwnerRunConnection({
          connectorId: "amazon",
          connectorInstanceId: shell.connectorInstanceId,
          connectorInstanceStore: store,
          ownerSubjectId: "owner_1",
        }),
      (err) => err instanceof ConnectorInstanceResolutionError && err.code === "connector_instance_inactive"
    );

    await assert.rejects(
      () =>
        admitOwnerBrowserEnrollmentRunConnection({
          connectorId: "amazon",
          connectorInstanceId: "amazon",
          connectorInstanceStore: store,
          ownerSubjectId: "owner_1",
        }),
      (err) => err instanceof ConnectorInstanceResolutionError && err.code === "connector_instance_not_found"
    );

    const staticDraft = makeDraft(store, { connectorId: "amazon", sourceBindingKey: "static_secret_draft" });
    assert.ok(staticDraft, "upsert returned the static-secret draft");
    const admittedStaticDraft = await admitOwnerRunConnection({
      allowDraft: true,
      connectorId: "amazon",
      connectorInstanceId: staticDraft.connectorInstanceId,
      connectorInstanceStore: store,
      ownerSubjectId: "owner_1",
    });
    assert.equal(admittedStaticDraft.connectorInstanceId, staticDraft.connectorInstanceId);
    assert.equal(admittedStaticDraft.status, "draft");
    await assert.rejects(
      () =>
        admitOwnerBrowserEnrollmentRunConnection({
          connectorId: "amazon",
          connectorInstanceId: staticDraft.connectorInstanceId,
          connectorInstanceStore: store,
          ownerSubjectId: "owner_1",
        }),
      (err) => err instanceof ConnectorInstanceResolutionError && err.code === "browser_enrollment_shell_required"
    );
  } finally {
    closeDb();
  }
});

test("activateDraft flips draft → active and is a no-op on non-draft rows", () => {
  initDb();
  try {
    seedConnector("gmail");
    const store = createSqliteConnectorInstanceStore();
    const draft = makeDraft(store, { sourceBindingKey: "nonce_activate" });
    assert.ok(draft, "upsert returned the new draft row");

    const activated = store.activateDraft(draft.connectorInstanceId, { now: LATER });
    assert.ok(activated, "activateDraft resolved the draft row");
    assert.equal(activated.status, "active");
    assert.equal(activated.updatedAt, LATER);
    // now visible on the read surface
    assert.ok(store.listByOwner("owner_1").some((i) => i.connectorInstanceId === draft.connectorInstanceId));

    // second activation is a no-op (idempotent / concurrency-safe)
    const again = store.activateDraft(draft.connectorInstanceId, { now: "2026-06-02T13:00:00.000Z" });
    assert.ok(again, "second activateDraft call still resolves the row");
    assert.equal(again.status, "active");
    assert.equal(again.updatedAt, LATER, "no-op did not re-stamp the row");

    // a paused row is NOT moved to active by activateDraft
    const paused = store.upsert({
      connectorId: "gmail",
      createdAt: NOW,
      displayName: "Paused",
      ownerSubjectId: "owner_1",
      sourceBinding: { kind: "account" },
      sourceBindingKey: "paused_binding",
      sourceKind: "account",
      status: "paused",
      updatedAt: NOW,
    });
    assert.ok(paused, "upsert returned the new paused row");
    const stillPaused = store.activateDraft(paused.connectorInstanceId, { now: LATER });
    assert.ok(stillPaused, "activateDraft still resolves the paused row (no-op, not deleted)");
    assert.equal(stillPaused.status, "paused");

    // activateDraft on a missing row returns null
    assert.equal(store.activateDraft("cin_does_not_exist", { now: LATER }), null);
  } finally {
    closeDb();
  }
});

test("browser enrollment shell sweep enumerates active shell bindings until they resolve", () => {
  initDb();
  try {
    seedConnector("amazon");
    const store = createSqliteConnectorInstanceStore();
    const draftShell = store.upsert({
      connectorId: "amazon",
      createdAt: NOW,
      displayName: "Amazon",
      ownerSubjectId: "owner_1",
      sourceBinding: {
        enrollment_expires_at: "2026-06-02T14:00:00.000Z",
        kind: "browser_enrollment_shell",
      },
      sourceBindingKey: "browser_shell_draft",
      sourceKind: "account",
      status: "draft",
      updatedAt: NOW,
    });
    assert.ok(draftShell, "upsert returned the new draft shell row");
    const activeShell = store.upsert({
      connectorId: "amazon",
      createdAt: NOW,
      displayName: "Amazon",
      ownerSubjectId: "owner_1",
      sourceBinding: {
        enrollment_expires_at: "2026-06-02T14:00:00.000Z",
        kind: "browser_enrollment_shell",
      },
      sourceBindingKey: "browser_shell_active",
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });
    assert.ok(activeShell, "upsert returned the new active shell row");
    store.upsert({
      connectorId: "amazon",
      createdAt: NOW,
      displayName: "Amazon - Personal",
      ownerSubjectId: "owner_1",
      sourceBinding: {
        enrollment_expires_at: "2026-06-02T14:00:00.000Z",
        kind: "browser_collector",
      },
      sourceBindingKey: "browser_collector_resolved",
      sourceKind: "account",
      status: "active",
      updatedAt: NOW,
    });

    const listed = store.listDraftBrowserEnrollmentShells("owner_1").map((instance) => instance.connectorInstanceId);

    assert.deepEqual(listed.sort(), [activeShell.connectorInstanceId, draftShell.connectorInstanceId].sort());
  } finally {
    closeDb();
  }
});

test("two drafts for one connector are two distinct connection_ids", () => {
  initDb();
  try {
    seedConnector("gmail");
    const store = createSqliteConnectorInstanceStore();
    const a = makeDraft(store, { sourceBindingKey: "mailbox_a" });
    const b = makeDraft(store, { sourceBindingKey: "mailbox_b" });
    assert.ok(a, "upsert returned the first draft row");
    assert.ok(b, "upsert returned the second draft row");
    assert.notEqual(a.connectorInstanceId, b.connectorInstanceId);
  } finally {
    closeDb();
  }
});
