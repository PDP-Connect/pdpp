// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  expiredEnrollmentShellIds,
  retireExpiredBrowserEnrollmentShells,
} from "../server/browser-enrollment-shell-retirement.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { promoteBrowserEnrollmentShellBinding } from "../server/routes/ref-browser-enrollment-shell.ts";
import {
  type ManualUploadDraftSourceBinding,
  promoteManualUploadDraftBinding,
} from "../server/routes/ref-manual-upload-draft-connection.ts";
import {
  promoteStaticSecretDraftBinding,
  type StaticSecretDraftSourceBinding,
} from "../server/routes/ref-static-secret-draft-connection.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
  isOwnerVisibleConnectorInstance,
} from "../server/stores/connector-instance-store.ts";

// Generic regression coverage: EVERY temporary setup binding kind
// (browser_enrollment_shell, static_secret_draft, manual_upload_draft — the
// members of RETIRED_SETUP_SHELL_BINDING_KINDS) must atomically promote to
// its durable sibling kind on first successful ingest, or a later revoke
// (TTL sweep for the browser shell; explicit owner revoke for the other
// two, which have no TTL sweep) wrongly hides a connection that holds real
// retained data, exactly like Sources hiding a 9,163-record ChatGPT
// connection while Explore still showed its records.
//
// This file drives the SAME three-scenario matrix — success promotes,
// abandon/failure stays hidden (never promoted), a promoted connection
// survives whatever revoke path applies to it and stays owner-visible —
// against all three kinds via one parameterized conformance body, proving
// the fix is generic (SETUP_BINDING_PROMOTIONS in server/index.ts), not
// browser-specific.

const NOW = "2026-08-06T09:00:00.000Z";
const PROMOTED_AT = "2026-08-06T09:05:00.000Z";

interface StoreLike {
  get: (id: string) => unknown | Promise<unknown>;
  listDraftBrowserEnrollmentShells: (ownerSubjectId: string | null) => unknown[] | Promise<unknown[]>;
  listOwnerVisibleIdentityPage: (
    ownerSubjectId: string,
    args: { after?: unknown; limit: number }
  ) => { hasMore: boolean; rows: readonly unknown[] } | Promise<{ hasMore: boolean; rows: readonly unknown[] }>;
  promoteSetupBinding: (
    connectorInstanceId: string,
    args: { fromKind: string; sourceBinding: Record<string, unknown>; updatedAt: string }
  ) => unknown | Promise<unknown>;
  updateStatus: (
    connectorInstanceId: string,
    args: { status: string; updatedAt: string; revokedAt?: string | null }
  ) => unknown | Promise<unknown>;
  upsert: (record: Record<string, unknown>) => unknown | Promise<unknown>;
}

interface ConnectorInstanceLike {
  connectorInstanceId: string;
  ownerSubjectId: string;
  revokedAt: string | null;
  sourceBinding: Record<string, unknown> | null;
  sourceBindingKey: string;
  sourceKind: string;
  status: string;
  updatedAt?: string;
}

interface KindFixture {
  readonly connectorId: string;
  draftBinding: (variant?: string) => Record<string, unknown>;
  readonly draftKind: string;
  readonly durableKind: string;
  // Fields from the draft binding that MUST survive promotion unchanged
  // (setup-specific durable metadata still needed for future runs).
  durableMetadataAssertions: (draftBinding: Record<string, unknown>, promotedBinding: Record<string, unknown>) => void;
  promote: (draftBinding: Record<string, unknown>, now: string) => Record<string, unknown>;
  readonly sourceKind: string;
}

const KIND_FIXTURES: readonly KindFixture[] = [
  {
    connectorId: "chatgpt",
    draftBinding: () => ({
      connector_id: "chatgpt",
      enrollment_expires_at: "2026-08-06T11:00:00.000Z",
      kind: "browser_enrollment_shell",
    }),
    draftKind: "browser_enrollment_shell",
    durableKind: "browser_collector",
    durableMetadataAssertions: (draftBinding, promotedBinding) => {
      assert.equal(promotedBinding.connector_id, draftBinding.connector_id, "connector_id survives promotion");
    },
    promote: (draftBinding, now) =>
      promoteBrowserEnrollmentShellBinding(
        draftBinding as unknown as Parameters<typeof promoteBrowserEnrollmentShellBinding>[0],
        now
      ) as unknown as Record<string, unknown>,
    sourceKind: "account",
  },
  {
    connectorId: "gmail",
    draftBinding: () => ({
      kind: "static_secret_draft",
      setup_fields: { account_email: "owner@example.com" },
    }),
    draftKind: "static_secret_draft",
    durableKind: "static_secret",
    durableMetadataAssertions: (draftBinding, promotedBinding) => {
      assert.deepEqual(
        promotedBinding.setup_fields,
        draftBinding.setup_fields,
        "setup_fields (non-secret manifest fields, read on every probe/run) survive promotion"
      );
    },
    promote: (draftBinding, now) =>
      promoteStaticSecretDraftBinding(
        draftBinding as unknown as StaticSecretDraftSourceBinding,
        now
      ) as unknown as Record<string, unknown>,
    sourceKind: "account",
  },
  {
    connectorId: "claude-code",
    draftBinding: () => ({
      acquisition_method: "owner_artifact",
      import_dir: "/tmp/pdpp-import/claude-code/abc123",
      import_dir_env_var: "CLAUDE_CODE_EXPORT_DIR",
      kind: "manual_upload_draft",
      uploaded_file_name: "export.zip",
    }),
    draftKind: "manual_upload_draft",
    durableKind: "manual_upload",
    durableMetadataAssertions: (draftBinding, promotedBinding) => {
      assert.equal(
        promotedBinding.import_dir,
        draftBinding.import_dir,
        "import_dir survives promotion — the run-env resolver reads it on EVERY run, not just setup"
      );
      assert.equal(promotedBinding.import_dir_env_var, draftBinding.import_dir_env_var);
      assert.equal(promotedBinding.uploaded_file_name, draftBinding.uploaded_file_name);
    },
    promote: (draftBinding, now) =>
      promoteManualUploadDraftBinding(
        draftBinding as unknown as ManualUploadDraftSourceBinding,
        now
      ) as unknown as Record<string, unknown>,
    sourceKind: "manual",
  },
];

async function runPromotionConformanceForKind({
  fixture,
  store,
  seedConnector,
  ownerSubjectId,
}: {
  fixture: KindFixture;
  store: StoreLike;
  seedConnector: (connectorId: string) => Promise<void>;
  ownerSubjectId: string;
}): Promise<void> {
  await seedConnector(fixture.connectorId);

  // --- Fail-before semantics: promoting a row that is NOT currently this
  // setup-binding kind must be a no-op, regardless of status.
  const nonSetupBinding = { kind: "account" };
  const nonSetupRow = (await store.upsert({
    connectorId: fixture.connectorId,
    createdAt: NOW,
    displayName: "Connection",
    ownerSubjectId,
    sourceBinding: nonSetupBinding,
    sourceBindingKey: `${ownerSubjectId}_${fixture.draftKind}_account_binding`,
    sourceKind: fixture.sourceKind,
    status: "active",
    updatedAt: NOW,
  })) as ConnectorInstanceLike;
  await store.promoteSetupBinding(nonSetupRow.connectorInstanceId, {
    fromKind: fixture.draftKind,
    sourceBinding: fixture.promote(fixture.draftBinding(), PROMOTED_AT),
    updatedAt: PROMOTED_AT,
  });
  const nonSetupAfter = (await store.get(nonSetupRow.connectorInstanceId)) as ConnectorInstanceLike;
  assert.deepEqual(nonSetupAfter.sourceBinding, nonSetupBinding, "promotion never touches an unrelated binding kind");
  assert.equal(nonSetupAfter.updatedAt, NOW, "promotion guard rejected the write; updated_at is untouched");

  // --- Success path: a draft that proves a successful first collection is
  // promoted — binding kind flips to the durable sibling, status flips to
  // active, identity is preserved exactly, and setup-specific durable
  // metadata survives.
  const draftKey = `${fixture.draftKind}_${ownerSubjectId}_success`;
  const draftBinding = fixture.draftBinding();
  const draft = (await store.upsert({
    connectorId: fixture.connectorId,
    createdAt: NOW,
    displayName: "Connection",
    ownerSubjectId,
    sourceBinding: draftBinding,
    sourceBindingKey: draftKey,
    sourceKind: fixture.sourceKind,
    status: "draft",
    updatedAt: NOW,
  })) as ConnectorInstanceLike;

  const promoted = (await store.promoteSetupBinding(draft.connectorInstanceId, {
    fromKind: fixture.draftKind,
    sourceBinding: fixture.promote(draftBinding, PROMOTED_AT),
    updatedAt: PROMOTED_AT,
  })) as ConnectorInstanceLike;

  assert.equal(promoted.connectorInstanceId, draft.connectorInstanceId, "connector_instance_id is preserved");
  assert.equal(promoted.ownerSubjectId, ownerSubjectId, "owner is preserved");
  assert.equal(promoted.sourceKind, fixture.sourceKind, "source_kind (identity axis) is preserved by promotion");
  assert.equal(promoted.sourceBindingKey, draftKey, "source_binding_key (identity axis) is preserved");
  assert.equal(promoted.status, "active", "promotion activates the connection");
  assert.equal(promoted.sourceBinding?.kind, fixture.durableKind, "binding kind moved to the durable sibling");
  fixture.durableMetadataAssertions(draftBinding, promoted.sourceBinding as Record<string, unknown>);

  // --- Idempotency: a second promotion call is a safe no-op.
  const promotedAgain = (await store.promoteSetupBinding(draft.connectorInstanceId, {
    fromKind: fixture.draftKind,
    sourceBinding: fixture.promote(draftBinding, "2026-08-06T09:10:00.000Z"),
    updatedAt: "2026-08-06T09:10:00.000Z",
  })) as ConnectorInstanceLike;
  assert.equal(promotedAgain.updatedAt, PROMOTED_AT, "second promotion call is a no-op; no re-stamp");

  // --- The exact live-repro shape: a promoted connection that is LATER
  // independently revoked stays visible on Sources — it is now an ordinary
  // revoked connection, not retired setup residue (its kind is no longer in
  // RETIRED_SETUP_SHELL_BINDING_KINDS).
  const revokedAfterPromotion = (await store.updateStatus(promoted.connectorInstanceId, {
    revokedAt: "2026-08-06T10:00:00.000Z",
    status: "revoked",
    updatedAt: "2026-08-06T10:00:00.000Z",
  })) as ConnectorInstanceLike;
  assert.ok(
    isOwnerVisibleConnectorInstance({
      sourceBinding: revokedAfterPromotion.sourceBinding,
      status: revokedAfterPromotion.status,
    }),
    `a revoked-after-promotion ${fixture.draftKind} connection stays visible on Sources`
  );
  const page = await store.listOwnerVisibleIdentityPage(ownerSubjectId, { limit: 50 });
  const visibleIds = (page.rows as ConnectorInstanceLike[]).map((row) => row.connectorInstanceId);
  assert.ok(
    visibleIds.includes(promoted.connectorInstanceId),
    "the promoted-then-revoked connection appears in the owner-visible identity page"
  );

  // --- Setup failure / abandon is unchanged: a draft that never collects a
  // record and is revoked stays retired setup residue — hidden from
  // Sources, exactly as before this fix. Promotion never fires for a row
  // that never proved success.
  const abandonedKey = `${fixture.draftKind}_${ownerSubjectId}_abandoned`;
  const abandonedDraft = (await store.upsert({
    connectorId: fixture.connectorId,
    createdAt: NOW,
    displayName: "Connection",
    ownerSubjectId,
    sourceBinding: fixture.draftBinding(),
    sourceBindingKey: abandonedKey,
    sourceKind: fixture.sourceKind,
    status: "draft",
    updatedAt: NOW,
  })) as ConnectorInstanceLike;
  const abandoned = (await store.updateStatus(abandonedDraft.connectorInstanceId, {
    revokedAt: NOW,
    status: "revoked",
    updatedAt: NOW,
  })) as ConnectorInstanceLike;
  assert.equal(
    abandoned.sourceBinding?.kind,
    fixture.draftKind,
    "an abandoned draft's binding kind is untouched — it was never promoted"
  );
  assert.ok(
    !isOwnerVisibleConnectorInstance({ sourceBinding: abandoned.sourceBinding, status: abandoned.status }),
    `an abandoned (never-promoted) ${fixture.draftKind} draft stays hidden from Sources, exactly as before this fix`
  );
  const pageAfterAbandon = await store.listOwnerVisibleIdentityPage(ownerSubjectId, { limit: 50 });
  const idsAfterAbandon = (pageAfterAbandon.rows as ConnectorInstanceLike[]).map((row) => row.connectorInstanceId);
  assert.ok(
    !idsAfterAbandon.includes(abandonedDraft.connectorInstanceId),
    "the abandoned draft does not leak into the owner-visible identity page"
  );
}

// The browser-enrollment-shell kind additionally has a TTL sweep (the other
// two kinds are only ever revoked by explicit owner action — see the
// setup-shell audit); this proves that sweep specifically never revokes a
// promoted connection, closing the exact live-repro shape (a ChatGPT
// connection that ran past its shell TTL after already being promoted).
async function assertPromotedBrowserShellSurvivesTtlSweep({
  store,
  ownerSubjectId,
}: {
  store: StoreLike;
  ownerSubjectId: string;
}): Promise<void> {
  const key = `browser_enrollment_shell_${ownerSubjectId}_ttl_survivor`;
  const draft = (await store.upsert({
    connectorId: "chatgpt",
    createdAt: NOW,
    displayName: "ChatGPT",
    ownerSubjectId,
    sourceBinding: {
      connector_id: "chatgpt",
      enrollment_expires_at: "2026-08-06T11:00:00.000Z",
      kind: "browser_enrollment_shell",
    },
    sourceBindingKey: key,
    sourceKind: "account",
    status: "draft",
    updatedAt: NOW,
  })) as ConnectorInstanceLike;
  const promoted = (await store.promoteSetupBinding(draft.connectorInstanceId, {
    fromKind: "browser_enrollment_shell",
    sourceBinding: promoteBrowserEnrollmentShellBinding(
      draft.sourceBinding as unknown as Parameters<typeof promoteBrowserEnrollmentShellBinding>[0],
      PROMOTED_AT
    ) as unknown as Record<string, unknown>,
    updatedAt: PROMOTED_AT,
  })) as ConnectorInstanceLike;

  const afterTtlExpiry = "2026-08-06T12:00:00.000Z";
  const survivorIds = expiredEnrollmentShellIds(
    [{ connectorInstanceId: promoted.connectorInstanceId, sourceBinding: promoted.sourceBinding, status: "active" }],
    afterTtlExpiry
  );
  assert.deepEqual(survivorIds, [], "a promoted connection is never eligible for shell TTL retirement");

  const retiredIds = await retireExpiredBrowserEnrollmentShells(
    {
      listDraftBrowserEnrollmentShells: (subjectId) =>
        Promise.resolve(
          store.listDraftBrowserEnrollmentShells(subjectId) as unknown as {
            connectorInstanceId: string;
            sourceBinding?: Record<string, unknown> | null;
            status: string;
          }[]
        ),
      updateStatus: (connectorInstanceId, args) => Promise.resolve(store.updateStatus(connectorInstanceId, args)),
    },
    { now: afterTtlExpiry, ownerSubjectId }
  );
  assert.ok(
    !retiredIds.includes(promoted.connectorInstanceId),
    "TTL retirement run past the shell TTL does not revoke the promoted connection"
  );
  const promotedAfterSweep = (await store.get(promoted.connectorInstanceId)) as ConnectorInstanceLike;
  assert.equal(promotedAfterSweep.status, "active", "promoted connection survives the TTL sweep untouched");
}

async function runFullConformance({
  store,
  seedConnector,
  ownerSubjectId,
}: {
  store: StoreLike;
  seedConnector: (connectorId: string) => Promise<void>;
  ownerSubjectId: string;
}): Promise<void> {
  for (const fixture of KIND_FIXTURES) {
    // biome-ignore lint/performance/noAwaitInLoops: Each kind's fixture rows must not interleave — sequential is correct here.
    await runPromotionConformanceForKind({
      fixture,
      ownerSubjectId: `${ownerSubjectId}_${fixture.draftKind}`,
      seedConnector,
      store,
    });
  }
  await assertPromotedBrowserShellSurvivesTtlSweep({
    ownerSubjectId: `${ownerSubjectId}_ttl`,
    store,
  });
}

test("SQLite: every setup-binding kind promotes on success, stays hidden on abandon, survives its revoke path", async () => {
  initDb();
  try {
    for (const connectorId of ["chatgpt", "gmail", "claude-code"]) {
      getDb()
        .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
        .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
    }
    const store = createSqliteConnectorInstanceStore() as unknown as StoreLike;
    await runFullConformance({ ownerSubjectId: "owner_sqlite", seedConnector: () => Promise.resolve(), store });
  } finally {
    closeDb();
  }
});

test("Postgres: every setup-binding kind promotes on success, stays hidden on abandon, survives its revoke path", {
  skip: !process.env.PDPP_TEST_POSTGRES_URL,
}, async () => {
  const databaseUrl = process.env.PDPP_TEST_POSTGRES_URL as string;
  await initPostgresStorage({ backend: "postgres", databaseUrl });
  const ownerSubjectId = "owner_postgres";
  try {
    await postgresQuery("DELETE FROM connector_instances WHERE owner_subject_id LIKE $1", [`${ownerSubjectId}%`]);
    const store = createPostgresConnectorInstanceStore() as unknown as StoreLike;
    await runFullConformance({
      ownerSubjectId,
      seedConnector: async (connectorId: string) => {
        await postgresQuery(
          `INSERT INTO connectors(connector_id, manifest, created_at)
             VALUES($1, $2::jsonb, $3)
             ON CONFLICT(connector_id) DO NOTHING`,
          [connectorId, JSON.stringify({ connector_id: connectorId }), NOW]
        );
      },
      store,
    });
  } finally {
    await postgresQuery("DELETE FROM connector_instances WHERE owner_subject_id LIKE $1", [`${ownerSubjectId}%`]);
    await closePostgresStorage();
  }
});
