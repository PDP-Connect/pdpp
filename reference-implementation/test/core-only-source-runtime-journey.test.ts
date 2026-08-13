// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  CoreSourceAuthorizationError,
  createRetainedCoreConsentSnapshot,
  materializeCoreResolvedGrant,
  readRetainedCoreConsentSnapshot,
  renderRetainedCoreConsent,
  resolveCoreEligibleInstanceIds,
  servePrecollectedCoreRecords,
  validateCoreSelectionRequest,
} from "../server/core-source-authorization.ts";

const SOURCE = { id: "https://sources.example/core/github", kind: "connector" } as const;
const INSTANCE_A = "opaque-github-account-a";
const INSTANCE_B = "opaque-github-account-b";
const NOT_DERIVABLE_RE = /not derivable/;

function declaration() {
  return {
    declaration_version: "github-core-v1",
    display: { name: "GitHub" },
    extensions: {},
    protocol_version: "0.1.0",
    publisher: { id: "https://publishers.example/github" },
    source: SOURCE,
    streams: [
      {
        consent_time_field: "updated_at",
        name: "issues",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            private_note: { type: "string" },
            title: { type: "string" },
            updated_at: { format: "date-time", type: "string" },
          },
          required: ["id", "updated_at"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
  };
}

function selection() {
  return {
    access_mode: "continuous",
    purpose_code: "https://pdpp.dev/purpose/research",
    streams: [
      {
        fields: ["title"],
        instance_ids: [INSTANCE_A],
        name: "issues",
        resources: ["issue-1"],
        time_range: { since: "2026-01-01T00:00:00Z" },
      },
    ],
    type: "https://pdpp.dev/data-access",
  };
}

test("Core-only connector validates, renders retained consent, issues a grant, and serves pre-collected records", () => {
  let liveDeclaration: ReturnType<typeof declaration> | null = declaration();
  const requestSelection = validateCoreSelectionRequest({ ...selection(), source: SOURCE });
  const snapshot = createRetainedCoreConsentSnapshot({
    declaration: liveDeclaration,
    selection: requestSelection,
    source: requestSelection.source,
    sourceSensitivity: "sensitive",
  });

  const [liveStream] = liveDeclaration.streams;
  assert.ok(liveStream);
  liveStream.schema.properties = {
    replacement_only: { type: "string" },
  } as unknown as typeof liveStream.schema.properties;
  liveDeclaration = null;
  assert.equal(liveDeclaration, null);

  const consent = renderRetainedCoreConsent({
    selection: requestSelection,
    snapshot,
    source: requestSelection.source,
  });
  assert.deepEqual(consent.display, { name: "GitHub" });
  assert.deepEqual(consent.resolvedStreams, [
    {
      fields: ["title", "id", "updated_at"],
      instance_ids: [INSTANCE_A],
      name: "issues",
      resources: ["issue-1"],
      time_constraint: { field: "updated_at", since: "2026-01-01T00:00:00Z" },
    },
  ]);

  const eligibleStreams = resolveCoreEligibleInstanceIds({
    eligibleInstanceIdsByStream: { issues: [INSTANCE_A] },
    streams: consent.resolvedStreams,
  });
  assert.throws(
    () =>
      resolveCoreEligibleInstanceIds({
        eligibleInstanceIdsByStream: { issues: [INSTANCE_B] },
        streams: consent.resolvedStreams,
      }),
    (error: unknown) =>
      error instanceof CoreSourceAuthorizationError && error.code === "source.authorization_details_invalid"
  );

  const grant = materializeCoreResolvedGrant({
    accessMode: requestSelection.access_mode,
    clientId: "research-app",
    expiresAt: null,
    grantId: "grant-core-1",
    issuedAt: "2026-08-11T12:00:00Z",
    purposeCode: requestSelection.purpose_code,
    resolvedStreams: eligibleStreams,
    snapshot,
    subjectId: "owner-1",
  });
  assert.deepEqual(grant.source, SOURCE);
  assert.equal(grant.source_declaration.version, "github-core-v1");

  const served = servePrecollectedCoreRecords({
    grant,
    instanceId: INSTANCE_A,
    records: [
      {
        data: {
          id: "issue-1",
          private_note: "must not be disclosed",
          title: "Visible issue",
          updated_at: "2026-02-01T00:00:00Z",
        },
        instance_id: INSTANCE_A,
        key: "issue-1",
        stream: "issues",
      },
      {
        data: { id: "issue-2", title: "Wrong resource", updated_at: "2026-02-01T00:00:00Z" },
        instance_id: INSTANCE_A,
        key: "issue-2",
        stream: "issues",
      },
      {
        data: { id: "issue-1", title: "Too old", updated_at: "2025-12-01T00:00:00Z" },
        instance_id: INSTANCE_A,
        key: "issue-1",
        stream: "issues",
      },
      {
        data: { id: "issue-1", title: "Wrong instance", updated_at: "2026-02-01T00:00:00Z" },
        instance_id: INSTANCE_B,
        key: "issue-1",
        stream: "issues",
      },
    ],
    stream: "issues",
  });
  assert.deepEqual(served, [
    {
      data: { id: "issue-1", title: "Visible issue", updated_at: "2026-02-01T00:00:00Z" },
      key: "issue-1",
      stream: "issues",
    },
  ]);
});

test("Core selection failures use the binding-neutral Source error", () => {
  assert.throws(
    () =>
      createRetainedCoreConsentSnapshot({
        declaration: declaration(),
        selection: {
          ...selection(),
          streams: [{ fields: ["missing"], instance_ids: [INSTANCE_A], name: "issues" }],
        },
        source: SOURCE,
        sourceSensitivity: "sensitive",
      }),
    (error: unknown) =>
      error instanceof CoreSourceAuthorizationError && error.code === "source.authorization_details_invalid"
  );
});

test("Core retained consent rejects malformed resolved streams and sensitivity with the neutral Source error", () => {
  const requestSelection = validateCoreSelectionRequest({ ...selection(), source: SOURCE });
  const snapshot = createRetainedCoreConsentSnapshot({
    declaration: declaration(),
    selection: requestSelection,
    source: SOURCE,
    sourceSensitivity: "sensitive",
  });
  for (const tampered of [
    { ...snapshot, resolved_streams: null },
    { ...snapshot, source_sensitivity: "" },
  ]) {
    assert.throws(
      () =>
        readRetainedCoreConsentSnapshot({
          selection: requestSelection,
          snapshot: tampered,
          source: SOURCE,
        }),
      (error: unknown) =>
        error instanceof CoreSourceAuthorizationError && error.code === "source.authorization_details_invalid"
    );
  }
});

test("Core retained consent survives declaration object-key reordering but not resolved array drift", () => {
  const requestSelection = validateCoreSelectionRequest({
    ...selection(),
    source: SOURCE,
    streams: [{ instance_ids: [INSTANCE_A], name: "issues" }],
  });
  const snapshot = createRetainedCoreConsentSnapshot({
    declaration: declaration(),
    selection: requestSelection,
    source: SOURCE,
    sourceSensitivity: "sensitive",
  });
  const roundTripped = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  const [roundTrippedStream] = roundTripped.declaration.streams;
  const properties = roundTrippedStream?.schema.properties;
  assert.ok(properties);
  assert.ok(roundTrippedStream);
  roundTrippedStream.schema.properties = Object.fromEntries(Object.entries(properties).reverse());
  assert.doesNotThrow(() =>
    readRetainedCoreConsentSnapshot({ selection: requestSelection, snapshot: roundTripped, source: SOURCE })
  );

  const changedArray = structuredClone(roundTripped);
  const [changedStream] = changedArray.resolved_streams;
  assert.ok(changedStream);
  changedStream.fields?.reverse();
  assert.throws(
    () => readRetainedCoreConsentSnapshot({ selection: requestSelection, snapshot: changedArray, source: SOURCE }),
    NOT_DERIVABLE_RE
  );
});
