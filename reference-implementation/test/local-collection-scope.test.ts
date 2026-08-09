// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The server side of the local-collector scope contract: where an owner's
// declared boundary durably lives, and when changing it must discard prior
// coverage proof.
//
// The storage choice is load-bearing and is asserted here rather than assumed.
// `connector_instances.source_binding_json` is hashed into the connection's
// identity, so scope cannot live there without making every scope edit a
// re-identification; the heartbeat-owned JSON columns are rewritten on every
// beat. `connector_state` is the durable, per-connection, server-owned store the
// collector already reads at run start, so a reserved non-stream key persists
// the boundary AND delivers it with no migration and no new endpoint.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStoredCollectionScope,
  COLLECTION_SCOPE_STATE_KEY,
  readStoredCollectionScope,
  scopeChangeInvalidatesProof,
} from "../server/local-collection-scope.ts";

const SINCE = "2026-06-01T00:00:00.000Z";
const DECLARED_AT = "2026-08-01T00:00:00.000Z";

test("the reserved scope key cannot collide with a manifest stream name", () => {
  // Manifest stream names are bare identifiers; the `$` prefix is unusable
  // there, which is what keeps a policy envelope out of the cursor namespace.
  assert.equal(COLLECTION_SCOPE_STATE_KEY.startsWith("$"), true);
});

test("a connection that declared no scope reads as an honest full pass", () => {
  assert.deepEqual(readStoredCollectionScope({}), { fingerprint: "unscoped", scope: null });
  assert.deepEqual(readStoredCollectionScope(null), { fingerprint: "unscoped", scope: null });
});

test("a declared scope round-trips through the durable envelope", () => {
  const stored = buildStoredCollectionScope({ since: SINCE }, DECLARED_AT);
  assert.equal(stored.fingerprint, `since=${SINCE}`);
  assert.equal(stored.declared_at, DECLARED_AT);

  const read = readStoredCollectionScope({ [COLLECTION_SCOPE_STATE_KEY]: stored });
  assert.deepEqual(read.scope, { since: SINCE });
  assert.equal(read.fingerprint, `since=${SINCE}`);
});

test("the fingerprint is recomputed on read, so a tampered row cannot assert a boundary its bounds do not describe", () => {
  const read = readStoredCollectionScope({
    [COLLECTION_SCOPE_STATE_KEY]: {
      declared_at: DECLARED_AT,
      // A hand-edited/partially-written row claiming a tighter bound than it holds.
      fingerprint: "since=2099-01-01T00:00:00.000Z",
      scope: { since: SINCE },
    },
  });
  assert.equal(read.fingerprint, `since=${SINCE}`, "the stored string is evidence, not authority");
});

test("a malformed scope entry degrades to unscoped rather than to a guessed boundary", () => {
  for (const bad of [{ scope: "since-yesterday" }, { scope: null }, { scope: [] }, "nonsense", 42]) {
    assert.deepEqual(
      readStoredCollectionScope({ [COLLECTION_SCOPE_STATE_KEY]: bad }),
      { fingerprint: "unscoped", scope: null },
      `malformed entry ${JSON.stringify(bad)} must not synthesize a bound`
    );
  }
});

// (d) a scope change INVALIDATES prior proof
test("changing the declared boundary invalidates prior proof, including to and from unscoped", () => {
  assert.equal(scopeChangeInvalidatesProof({ since: SINCE }, { since: "2026-07-01T00:00:00.000Z" }), true);
  assert.equal(scopeChangeInvalidatesProof(null, { since: SINCE }), true, "introducing a bound is a change");
  assert.equal(scopeChangeInvalidatesProof({ since: SINCE }, null), true, "removing a bound is a change");
});

test("a no-op edit does NOT discard valid proof", () => {
  assert.equal(
    scopeChangeInvalidatesProof({ since: SINCE, source_roots: ["a", "b"] }, { source_roots: ["b", "a", "a"], since: `  ${SINCE}  ` }),
    false,
    "reordered/duplicated roots and padded bounds normalize to the same region"
  );
});

test("narrowing a boundary still invalidates: prior wider proof did not measure the narrower region", () => {
  assert.equal(scopeChangeInvalidatesProof({ since: SINCE }, { since: SINCE, source_roots: ["proj-a"] }), true);
});
