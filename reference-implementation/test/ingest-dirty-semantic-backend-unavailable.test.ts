// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Discriminating test for a review-flagged gap in reconcileSearchIndexDirtyScope
// (server/search-index-reconcile.ts): a stream whose manifest DECLARES
// semantic_fields (semantic participation is configured/intended) must not
// have its combined lexical+semantic dirty flag cleared merely because
// getSemanticBackend() happens to be null when this particular reconcile
// attempt runs. Clearing in that case would silently declare "semantic is in
// sync" for a scope whose semantic index was never actually checked --
// permanently dropping pending proof the moment a backend later comes online,
// since the dirty flag (the only durable signal that this scope needs
// checking) would already be cleared.

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";
import { reconcileSearchIndexDirtyScope, runSearchIndexDirtyReconcileRound } from "../server/search-index-reconcile.ts";
import { configureSemanticBackend, makeStubBackend } from "../server/search-semantic.ts";
import { isSearchIndexScopeDirty, listDirtySearchIndexScopes } from "../server/stores/search-index-dirty-store.ts";

function target(connectorId: string, connectorInstanceId: string) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

function record(stream: string, key: string, subject: string) {
  return {
    data: { id: key, subject },
    emitted_at: "2026-08-09T00:00:00.000Z",
    key,
    stream,
  };
}

function manifestWithSemanticFields(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        query: { search: { lexical_fields: ["subject"], semantic_fields: ["subject"] } },
        schema: {
          properties: { id: { type: "string" }, subject: { type: "string" } },
          required: ["id", "subject"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

test("a scope whose stream declares semantic_fields is NOT cleared when no semantic backend is configured", async () => {
  initDb(":memory:");
  try {
    // No configureSemanticBackend call at all: getSemanticBackend() returns
    // null for the whole duration of this test, exactly the "server-wide
    // semantic disabled/not-yet-warmed" condition under review.
    configureSemanticBackend(null);

    const connectorId = "inv-semantic-backend-unavailable";
    await registerConnector(manifestWithSemanticFields(connectorId));
    const connectorInstanceId = "cin_semantic_backend_unavailable";

    await ingestRecord(target(connectorId, connectorInstanceId), record("items", "k1", "wants semantic too"));

    const scopes = await listDirtySearchIndexScopes(10);
    const scope = scopes.find((s) => s.connectorInstanceId === connectorInstanceId);
    assert.ok(scope, "the scope is durably dirty after ingest");

    const result = await reconcileSearchIndexDirtyScope(scope);

    assert.equal(
      result.outcome,
      "failed",
      "reconcile must NOT report success for a scope whose semantic participation is configured but unchecked"
    );
    assert.equal(
      await isSearchIndexScopeDirty({ connectorInstanceId, stream: "items" }),
      true,
      "the dirty flag must remain set -- semantic sync was never actually proven, only lexical was"
    );
  } finally {
    configureSemanticBackend(null);
    closeDb();
  }
});

test("the SAME scope converges once a semantic backend becomes available, using the SAME retained dirty flag", async () => {
  initDb(":memory:");
  try {
    configureSemanticBackend(null);

    const connectorId = "inv-semantic-backend-recovers";
    await registerConnector(manifestWithSemanticFields(connectorId));
    const connectorInstanceId = "cin_semantic_backend_recovers";

    await ingestRecord(target(connectorId, connectorInstanceId), record("items", "k1", "wants semantic too"));

    // First reconcile attempt: no backend yet, must not clear (per the test
    // above). Calls reconcileSearchIndexDirtyScope directly (rather than
    // going through runSearchIndexDirtyReconcileRound's
    // listDirtySearchIndexScopes page, which applies starvation-avoidance
    // backoff -- a correct, orthogonal invariant this test intentionally
    // does not exercise) to isolate exactly the behavior under test: does
    // the SAME retained dirty flag let a later attempt actually converge
    // once a backend exists.
    const scopesBefore = await listDirtySearchIndexScopes(10);
    const scope = scopesBefore.find((s) => s.connectorInstanceId === connectorInstanceId);
    assert.ok(scope, "scope is dirty before the first attempt");
    const attempt1 = await reconcileSearchIndexDirtyScope(scope);
    assert.equal(attempt1.outcome, "failed");
    assert.equal(
      await isSearchIndexScopeDirty({ connectorInstanceId, stream: "items" }),
      true,
      "still dirty -- semantic was never checked"
    );

    // A semantic backend becomes available (e.g. warmup completes, or an
    // operator re-enables the extension). The SAME durable dirty flag --
    // never cleared by the unproven attempt above -- is what lets this
    // scope still be found and actually checked now. (Re-querying via
    // listDirtySearchIndexScopes here would apply the starvation-avoidance
    // backoff eligibility filter from the fix above and legitimately
    // exclude this just-failed scope for a few seconds -- a correct,
    // orthogonal invariant this test does not exercise. reconcileSearchIndexDirtyScope
    // itself has no such filter, so calling it directly with the same scope
    // identity isolates exactly the behavior under test.)
    configureSemanticBackend(makeStubBackend({ dimensions: 8 }));

    const attempt2 = await reconcileSearchIndexDirtyScope(scope);
    assert.equal(
      attempt2.outcome,
      "converged",
      "now that a backend exists, the retained dirty flag lets reconcile actually check and converge it"
    );
    assert.equal(
      await isSearchIndexScopeDirty({ connectorInstanceId, stream: "items" }),
      false,
      "cleared only now, having actually been checked"
    );
  } finally {
    configureSemanticBackend(null);
    closeDb();
  }
});

test("a scope whose stream does NOT declare semantic_fields clears normally with no semantic backend configured", async () => {
  initDb(":memory:");
  try {
    configureSemanticBackend(null);

    const connectorId = "inv-lexical-only-no-semantic-backend";
    await registerConnector({
      capabilities: { human_interaction: [] },
      connector_id: connectorId,
      display_name: connectorId,
      manifest_uri: `https://sources.example/${connectorId}`,
      protocol_version: "0.1.0",
      streams: [
        {
          name: "items",
          primary_key: ["id"],
          query: { search: { lexical_fields: ["subject"] } }, // no semantic_fields
          schema: {
            properties: { id: { type: "string" }, subject: { type: "string" } },
            required: ["id", "subject"],
            type: "object",
          },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
      ],
      version: "0.1.0",
    });
    const connectorInstanceId = "cin_lexical_only";

    await ingestRecord(target(connectorId, connectorInstanceId), record("items", "k1", "lexical only"));

    const round = await runSearchIndexDirtyReconcileRound({ maxDurationMs: 2000, pageSize: 10 });
    assert.equal(
      round.succeeded,
      1,
      "a stream that never declared semantic_fields has nothing semantic to prove, and converges normally"
    );
    assert.equal(await isSearchIndexScopeDirty({ connectorInstanceId, stream: "items" }), false);
  } finally {
    configureSemanticBackend(null);
    closeDb();
  }
});
