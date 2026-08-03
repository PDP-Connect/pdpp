// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stored grant storage bindings carrying `connector_instance_id` must remain
 * valid — and therefore revocable.
 *
 * The defect: `requireStructuredGrantBindings` validated STORED bindings with
 * the request-time rule "must contain exactly connector_id". The writer had
 * since begun persisting `connector_instance_id` alongside it as part of the
 * connection-identity model, so the validator became stricter than the data
 * the system itself emits. On a real deployment 42 active grants carried the
 * extra key and were permanently unrevokable — rejected `grant_invalid` while
 * being `status=active` and perfectly well-formed:
 *
 *   grant.revoke_rejected
 *   {"error":{"code":"grant_invalid","message":"Grant is malformed or no longer valid"}}
 *
 * Exercised through `requirePersistedGrantState`, which takes a raw DB row —
 * the same entry point revocation uses — so this tests the real path rather
 * than a private helper.
 *
 * What must NOT regress, asserted rather than assumed:
 *   - an unknown key in a stored row is still a hard failure (allowlist, not
 *     a blanket relaxation);
 *   - a stored binding missing `connector_id` is still rejected;
 *   - source↔storage authority matching still rejects a mismatched binding.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { requirePersistedGrantState } from "../server/auth.ts";

const CONNECTOR = "codex";
const INSTANCE = "cin_ece4bfe5096b8bf67a1468c2";

/** A persisted row shaped like the live rows that could not be revoked. */
function row(storageBinding: unknown, sourceId: string = CONNECTOR) {
  return {
    grant_json: JSON.stringify({
      grant_id: "grt_cbe8070bb57a6926",
      source: { kind: "connector", id: sourceId },
      streams: [],
    }),
    storage_binding_json: JSON.stringify(storageBinding),
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ?? (err as { code?: string }).code;
  }
  return undefined;
}

test("a stored binding with connector_instance_id validates (the unrevokable-grant case)", () => {
  const state = requirePersistedGrantState(row({ connector_id: CONNECTOR, connector_instance_id: INSTANCE }));
  assert.equal(state.storageBinding.connector_id, CONNECTOR);
  // Authority is still normalized down to connector_id alone — the extra key
  // is tolerated on input, never promoted into the effective binding.
  assert.deepEqual(Object.keys(state.storageBinding), ["connector_id"]);
});

test("a stored binding with only connector_id still validates (rows predating the extra key)", () => {
  const state = requirePersistedGrantState(row({ connector_id: CONNECTOR }));
  assert.equal(state.storageBinding.connector_id, CONNECTOR);
});

test("an UNKNOWN key in a stored binding is still rejected — allowlist, not relaxation", () => {
  assert.equal(codeOf(() => requirePersistedGrantState(row({ connector_id: CONNECTOR, smuggled_scope: "*" }))), "grant_invalid");
});

test("a stored binding missing connector_id is still rejected", () => {
  assert.equal(codeOf(() => requirePersistedGrantState(row({ connector_instance_id: INSTANCE }))), "grant_invalid");
});

test("source/storage authority mismatch is still rejected", () => {
  assert.equal(
    codeOf(() =>
      requirePersistedGrantState(row({ connector_id: CONNECTOR, connector_instance_id: INSTANCE }, "other-connector"))
    ),
    "grant_invalid"
  );
});
