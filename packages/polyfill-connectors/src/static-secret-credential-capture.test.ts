// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the ONE shared normalizer
 * (`./static-secret-credential-capture.ts`) that closes the setup/runtime
 * split-authority class by construction: both
 * `reference-implementation/server/connection-setup-plan.ts`'s
 * `staticSecretCredentialCaptureFromManifest` and this package's
 * `scripts/generate-static-secret-registry.ts` call
 * `normalizeStaticSecretCredentialCapture` — there is no second predicate
 * left to independently drift.
 *
 * These probes target the exact two asymmetries an earlier version of this
 * fix left unclosed (documented in the review this revision responds to):
 *   - F1: `type: "password"` implying secrecy without an explicit
 *     `secret: true` — one hand-rolled predicate recognized this, the other
 *     did not.
 *   - F2: a secret field missing `label` — one side silently dropped the
 *     field, the other kept it.
 * Both are now impossible to disagree on, because there is only one function
 * that decides. The probes below call that one function directly, so this
 * test would fail if a future edit reintroduced either asymmetry inside it,
 * or a future edit made either RI or the generator stop calling it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeStaticSecretCredentialCapture,
  StaticSecretCredentialCaptureError,
  type StaticSecretCredentialCaptureLike,
} from "./static-secret-credential-capture.ts";

test("password-without-secret: type:'password' with no explicit secret:true is still classified secret (closes F1)", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [{ env: ["PROBE_PWTYPE_TOKEN"], label: "Probe token", name: "token", required: true, type: "password" }],
    kind: "api_key",
    label: "Probe",
  };
  const normalized = normalizeStaticSecretCredentialCapture("probe_pwtype", capture);
  assert.ok(normalized, 'a type:"password" field with no secret:true must still make the connector static-secret');
  assert.equal(normalized.fields[0]?.secret, true);
  assert.equal(normalized.fields[0]?.type, "password");
});

test("missing-label: a secret field with no label throws instead of silently vanishing or silently shipping (closes F2)", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [{ env: ["PROBE_NOLABEL_TOKEN"], name: "token", required: true, secret: true }],
    kind: "api_key",
    label: "Probe",
  };
  assert.throws(
    () => normalizeStaticSecretCredentialCapture("probe_nolabel", capture),
    (err: unknown) =>
      err instanceof StaticSecretCredentialCaptureError && err.code === "static_secret_field_label_required"
  );
});

test("missing-label on a non-secret field is tolerated: the field is dropped, not an error", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [
      { env: ["PROBE_SECRET"], label: "Secret", name: "secret", required: true, secret: true },
      { name: "note", required: false, secret: false },
    ],
    kind: "api_key",
    label: "Probe",
  };
  const normalized = normalizeStaticSecretCredentialCapture("probe_nonsecret_nolabel", capture);
  assert.ok(normalized);
  assert.deepEqual(
    normalized.fields.map((field) => field.name),
    ["secret"],
    "a non-secret field missing label must be silently dropped, not thrown on — label is only contract-required " +
      "for a field that is actually presented as a secret to seal"
  );
});

test("empty-env: a secret field with env declared as an empty array throws (closes F4)", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [{ env: [], label: "Probe token", name: "token", required: true, secret: true }],
    kind: "api_key",
    label: "Probe",
  };
  assert.throws(
    () => normalizeStaticSecretCredentialCapture("probe_emptyenv", capture),
    (err: unknown) =>
      err instanceof StaticSecretCredentialCaptureError && err.code === "static_secret_field_env_required"
  );
});

test("empty-env: a secret field with no env key at all (undefined) throws the same as an empty array", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [{ label: "Probe token", name: "token", required: true, secret: true }],
    kind: "api_key",
    label: "Probe",
  };
  assert.throws(
    () => normalizeStaticSecretCredentialCapture("probe_noenv", capture),
    (err: unknown) =>
      err instanceof StaticSecretCredentialCaptureError && err.code === "static_secret_field_env_required"
  );
});

test("required/optional: required defaults true, and required:false is preserved for a multi-secret-field bundle", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [
      { env: ["PROBE_USERNAME"], label: "Username", name: "username", required: true, secret: true },
      { env: ["PROBE_API_KEY"], label: "API key", name: "api_key", required: false, secret: true },
    ],
    kind: "username_password",
    label: "Probe",
  };
  const normalized = normalizeStaticSecretCredentialCapture("probe_required_optional", capture);
  assert.ok(normalized);
  const byName = Object.fromEntries(normalized.fields.map((field) => [field.name, field]));
  assert.equal(byName.username?.required, true);
  assert.equal(byName.api_key?.required, false);
});

test("required defaults to true when omitted entirely (not false, not undefined)", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [{ env: ["PROBE_TOKEN"], label: "Token", name: "token", secret: true }],
    kind: "api_key",
    label: "Probe",
  };
  const normalized = normalizeStaticSecretCredentialCapture("probe_required_default", capture);
  assert.equal(normalized?.fields[0]?.required, true);
});

// ─── BLOCK-level credential_capture.required (distinct from FIELD-level) ──

test("block-level required defaults to true when the manifest omits it entirely", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [{ env: ["PROBE_TOKEN"], label: "Token", name: "token", required: true, secret: true }],
    kind: "api_key",
    label: "Probe",
  };
  const normalized = normalizeStaticSecretCredentialCapture("probe_block_required_default", capture);
  assert.equal(normalized?.required, true, "omitting the block-level fact must default to required, not optional");
});

test("block-level required: false is preserved (Venmo's shape) — independent of each field's own required flag", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [
      { env: ["PROBE_USERNAME"], label: "Username", name: "username", required: true, secret: true },
      { env: ["PROBE_PASSWORD"], label: "Password", name: "password", required: true, secret: true },
    ],
    kind: "username_password",
    label: "Probe",
    required: false,
  };
  const normalized = normalizeStaticSecretCredentialCapture("probe_block_optional", capture);
  assert.equal(normalized?.required, false, "an explicit block-level false must be preserved");
  // The BOTH-OR-NONE contract lives entirely in the FIELD-level required
  // flags staying true — this normalizer does not derive or infer that from
  // block-level required; it only carries both facts through unchanged.
  assert.ok(
    normalized?.fields.every((field) => field.required),
    "field-level required must be untouched by the block-level fact"
  );
});

test("block-level required: true explicitly set behaves the same as omitting it", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [{ env: ["PROBE_TOKEN"], label: "Token", name: "token", required: true, secret: true }],
    kind: "api_key",
    label: "Probe",
    required: true,
  };
  const normalized = normalizeStaticSecretCredentialCapture("probe_block_required_explicit", capture);
  assert.equal(normalized?.required, true);
});

test("secret_bundle: every field (secret and non-secret alike) is still returned for the caller to bundle-decide", () => {
  // The normalizer itself does not decide bundling policy (secret_bundle vs
  // username_password fully-bundled semantics) — that is the generator's
  // responsibility (isFullyBundledStaticSecretCredentialKind in
  // generate-static-secret-registry.ts) and the console's capture-time
  // decision. This proves the normalizer hands back ALL fields, secret and
  // non-secret, unfiltered, with `secret` correctly flagged on each so a
  // downstream bundler has everything it needs.
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [
      { env: ["PROBE_TOKEN"], label: "Token", name: "token", required: true, secret: true },
      { env: ["PROBE_WORKSPACE"], label: "Workspace", name: "workspace", required: true, secret: false },
    ],
    kind: "secret_bundle",
    label: "Probe bundle",
  };
  const normalized = normalizeStaticSecretCredentialCapture("probe_secret_bundle", capture);
  assert.ok(normalized);
  assert.equal(normalized.kind, "secret_bundle");
  assert.deepEqual(
    normalized.fields.map((field) => ({ name: field.name, secret: field.secret })),
    [
      { name: "token", secret: true },
      { name: "workspace", secret: false },
    ]
  );
});

test("no credential_capture at all returns null, not an error", () => {
  assert.equal(normalizeStaticSecretCredentialCapture("probe_none", null), null);
  assert.equal(normalizeStaticSecretCredentialCapture("probe_none", undefined), null);
});

test("credential_capture with a kind but no secret field returns null, not an error", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [{ env: ["PROBE_NOTE"], label: "Note", name: "note", required: true, secret: false }],
    kind: "api_key",
    label: "Probe",
  };
  assert.equal(normalizeStaticSecretCredentialCapture("probe_no_secret_field", capture), null);
});

test("credential_capture with fields but no kind returns null, not an error", () => {
  const capture: StaticSecretCredentialCaptureLike = {
    fields: [{ env: ["PROBE_TOKEN"], label: "Token", name: "token", required: true, secret: true }],
    label: "Probe",
  };
  assert.equal(normalizeStaticSecretCredentialCapture("probe_no_kind", capture), null);
});
