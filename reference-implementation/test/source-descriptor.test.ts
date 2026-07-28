// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure source-descriptor builders.
 *
 * source-descriptor.ts has no co-named test; route tests import a couple of
 * its helpers but never unit-pin the descriptor builders. The async
 * resolveOwnerReadScope needs stores and is out of scope here — these tests
 * cover only the pure, synchronous exports and OBSERVE grant/token shapes
 * without changing behavior. Coverage:
 *   - buildSourceDescriptor kind+id gating (connector / provider_native),
 *   - resolveGrantStorageBinding presence gating,
 *   - buildClientSourceDescriptor precedence (grant.source over storage binding),
 *   - buildOwnerQuerySourceDescriptor native-manifest precedence + canonicalization,
 *   - resolveNativeStorageBinding / resolveNativeManifest,
 *   - resolveSingleConnectorIdQueryValue trimming,
 *   - getOwnerTokenSubjectId default fallback.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import {
  buildClientSourceDescriptor,
  buildOwnerQuerySourceDescriptor as buildOwnerQuerySourceDescriptorUntyped,
  buildSourceDescriptor as buildSourceDescriptorUntyped,
  getOwnerTokenSubjectId,
  resolveGrantStorageBinding,
  resolveNativeManifest,
  resolveNativeStorageBinding,
  resolveSingleConnectorIdQueryValue,
} from "../server/source-descriptor.ts";

// Both carry a default-parameter type in their untyped JS declarations
// (server/source-descriptor.ts) that TS infers as narrower than the real
// runtime contract, as every call below proves.
type SourceDescriptor = { kind: string; id: string } | null;
const buildSourceDescriptor = buildSourceDescriptorUntyped as (sourceBinding?: unknown) => SourceDescriptor;
const buildOwnerQuerySourceDescriptor = buildOwnerQuerySourceDescriptorUntyped as (
  req: unknown,
  opts?: unknown
) => SourceDescriptor;

test("buildSourceDescriptor gates on kind + id and returns null otherwise", () => {
  assert.deepEqual(buildSourceDescriptor({ id: "gmail", kind: "connector" }), { id: "gmail", kind: "connector" });
  assert.deepEqual(buildSourceDescriptor({ id: "apple", kind: "provider_native" }), {
    id: "apple",
    kind: "provider_native",
  });
  assert.equal(buildSourceDescriptor({ kind: "connector" }), null); // missing id
  assert.equal(buildSourceDescriptor({ kind: "provider_native" }), null); // missing id
  assert.equal(buildSourceDescriptor({ id: "x", kind: "other" }), null); // unknown kind
  assert.equal(buildSourceDescriptor(null), null);
});

test("resolveGrantStorageBinding returns the binding only when it names a connector_id", () => {
  const binding = { connector_id: "gmail", connector_instance_id: "cin_1" };
  assert.deepEqual(resolveGrantStorageBinding({ grant_storage_binding: binding }), binding);
  assert.equal(resolveGrantStorageBinding({ grant_storage_binding: { connector_id: "" } }), null);
  assert.equal(resolveGrantStorageBinding({}), null);
  assert.equal(resolveGrantStorageBinding(null), null);
});

test("buildClientSourceDescriptor prefers grant.source over the storage binding", () => {
  const tokenInfo = {
    grant: { source: { id: "apple", kind: "provider_native" } },
    grant_storage_binding: { connector_id: "gmail" },
  };
  assert.deepEqual(buildClientSourceDescriptor(tokenInfo), { id: "apple", kind: "provider_native" });
});

test("buildClientSourceDescriptor falls back to the storage binding connector_id", () => {
  const tokenInfo = { grant_storage_binding: { connector_id: "gmail" } };
  assert.deepEqual(buildClientSourceDescriptor(tokenInfo), { id: "gmail", kind: "connector" });
  // Nothing resolvable -> null.
  assert.equal(buildClientSourceDescriptor({}), null);
  assert.equal(buildClientSourceDescriptor(null), null);
});

test("resolveNativeManifest / resolveNativeStorageBinding read the injected native manifest", () => {
  assert.equal(resolveNativeManifest({}), null);
  const opts = { nativeManifest: { provider_id: "apple", storage_binding: { connector_id: "apple_native" } } };
  assert.deepEqual(resolveNativeManifest(opts), opts.nativeManifest);
  assert.deepEqual(resolveNativeStorageBinding(opts), { connector_id: "apple_native" });
  // No storage_binding.connector_id -> null.
  assert.equal(resolveNativeStorageBinding({ nativeManifest: { provider_id: "apple" } }), null);
});

test("buildOwnerQuerySourceDescriptor prefers the native manifest provider over the query connector_id", () => {
  const req = { query: { connector_id: "gmail" } };
  const opts = { nativeManifest: { provider_id: "apple" } };
  assert.deepEqual(buildOwnerQuerySourceDescriptor(req, opts), { id: "apple", kind: "provider_native" });
});

test("buildOwnerQuerySourceDescriptor canonicalizes a URL-shaped connector_id", () => {
  const req = { query: { connector_id: "https://registry.pdpp.org/connectors/gmail" } };
  const out = buildOwnerQuerySourceDescriptor(req, {});
  assert.ok(out, "expected a source descriptor");
  assert.equal(out.kind, "connector");
  // Canonicalized to the bare key rather than the registry URL.
  assert.equal(out.id, "gmail");
});

test("buildOwnerQuerySourceDescriptor returns null when no connector_id is present", () => {
  assert.equal(buildOwnerQuerySourceDescriptor({ query: {} }, {}), null);
});

test("resolveSingleConnectorIdQueryValue trims and rejects non-string / blank", () => {
  assert.equal(resolveSingleConnectorIdQueryValue("  gmail  "), "gmail");
  assert.equal(resolveSingleConnectorIdQueryValue("   "), null);
  assert.equal(resolveSingleConnectorIdQueryValue(["gmail"]), null); // array wire shape
  assert.equal(resolveSingleConnectorIdQueryValue(undefined), null);
});

test("getOwnerTokenSubjectId falls back to the default owner subject", () => {
  assert.equal(getOwnerTokenSubjectId({ tokenInfo: { subject_id: "owner_x" } }), "owner_x");
  assert.equal(getOwnerTokenSubjectId({}), OWNER_AUTH_DEFAULT_SUBJECT_ID);
});
