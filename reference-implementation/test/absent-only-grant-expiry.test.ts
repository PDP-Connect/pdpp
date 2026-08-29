// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pins the two normative rules split out of #168:
//
//  1. Grant `expires_at` is absent-only. A grant with no expiry OMITS the
//     field; `null` is not a valid wire value. Because grants issued before
//     that normalization persisted an explicit `"expires_at": null` inside
//     `grants.grant_json`, and those blobs are re-parsed on every read, the
//     parse choke point accepts-and-normalizes rather than rejecting: it drops
//     the legacy member so every downstream caller sees the single terminal
//     shape. `null` and absent already mean the same thing (no expiry), so
//     this is a representation change, not an authorization change.
//
//  2. Clients treat unrecognized error codes as opaque, falling back to the
//     HTTP status class and the error `type` (spec-core.md Client conformance
//     item 7). A client MUST that no test exercises is untestable in practice.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ResolvedGrantSchema } from "@pdpp/reference-contract/public/source";
import { PdppHttpError } from "../cli/lib/errors.ts";
import { materializeCoreResolvedGrant, parseCoreResolvedGrant } from "../server/core-source-authorization.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { typeFor } from "../server/routes/ref-error-status.ts";

const SOURCE = { id: "https://sources.example/core/github", kind: "connector" } as const;
const INSTANCE = "opaque-github-account-a";

// Same Ajv wiring the server uses, so the schema assertions below exercise the
// real compiled validator rather than a re-description of it.
const requireFromContract = createRequire(import.meta.resolve("@pdpp/reference-contract"));
const Ajv2020 = requireFromContract("ajv/dist/2020.js") as new (
  options?: Record<string, unknown>
) => {
  compile: (schema: object) => (value: unknown) => boolean;
};
const addFormats = requireFromContract("ajv-formats") as (ajv: unknown) => void;

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

function snapshot() {
  return {
    declaration_version: "github-core-v1",
    display: { name: "GitHub" },
    source: SOURCE,
    source_sensitivity: "sensitive",
    streams: declaration().streams,
  } as unknown as Parameters<typeof materializeCoreResolvedGrant>[0]["snapshot"];
}

function resolvedStreams() {
  return [
    {
      fields: ["title", "id", "updated_at"],
      instance_ids: [INSTANCE],
      name: "issues",
      resources: ["issue-1"],
      time_constraint: { field: "updated_at", since: "2026-01-01T00:00:00Z" },
    },
  ] as unknown as Parameters<typeof materializeCoreResolvedGrant>[0]["resolvedStreams"];
}

function grantWith(expiresAt: string | null) {
  return materializeCoreResolvedGrant({
    accessMode: "continuous",
    clientId: "research-app",
    expiresAt,
    grantId: "grant-core-1",
    issuedAt: "2026-08-11T12:00:00Z",
    purposeCode: "https://pdpp.dev/purpose/research",
    resolvedStreams: resolvedStreams(),
    snapshot: snapshot(),
    subjectId: "owner-1",
  });
}

// --- 1. expires_at is absent-only ---------------------------------------

test("a grant with no expiry omits expires_at rather than emitting null", () => {
  const grant = grantWith(null);
  assert.equal("expires_at" in grant, false, "no-expiry grant must not carry an expires_at member");
  assert.equal(grant.expires_at, undefined);
  // Absence must survive serialization — this is the wire representation.
  assert.equal(JSON.stringify(grant).includes("expires_at"), false);
});

test("a grant with an expiry still carries expires_at verbatim", () => {
  const grant = grantWith("2027-04-06T00:00:00Z");
  assert.equal(grant.expires_at, "2027-04-06T00:00:00Z");
});

test("the grant JSON Schema rejects an explicit null expires_at", () => {
  // Pins the contract itself rather than the parse choke point. Without this,
  // reverting the generation site is masked: materializeCoreResolvedGrant ends
  // in parseCoreResolvedGrant, whose normalizer would quietly absorb the null.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(ResolvedGrantSchema);

  const valid = grantWith("2027-04-06T00:00:00Z");
  assert.equal(validate(valid), true, "a string expiry must validate");

  assert.equal(validate({ ...valid, expires_at: null }), false, "null must no longer satisfy the grant schema");

  const { expires_at: _omitted, ...absent } = valid;
  assert.equal(validate(absent), true, "an absent expiry must validate");
});

test("an absent expires_at parses as valid and means no expiry", () => {
  const parsed = parseCoreResolvedGrant(grantWith(null));
  assert.equal("expires_at" in parsed, false);
  assert.equal(parsed.expires_at, undefined);
});

test("a legacy explicit-null expires_at is normalized to absent on parse", () => {
  // The shape persisted in grants.grant_json before absent-only. It must stay
  // readable (accept) and must come back in the terminal shape (normalize).
  const legacy = { ...grantWith(null), expires_at: null };
  assert.equal(legacy.expires_at, null, "fixture must actually carry the legacy null");

  const parsed = parseCoreResolvedGrant(legacy);

  assert.equal("expires_at" in parsed, false, "explicit null must be dropped, not preserved");
  assert.equal(parsed.expires_at, undefined);
  // Normalizing must not disturb the rest of the grant.
  assert.equal(parsed.grant_id, "grant-core-1");
  assert.equal(parsed.access_mode, "continuous");
});

test("normalizing a legacy null never rewrites a real expiry", () => {
  const parsed = parseCoreResolvedGrant(grantWith("2027-04-06T00:00:00Z"));
  assert.equal(parsed.expires_at, "2027-04-06T00:00:00Z");
});

// --- 1b. the persisted-state migration ----------------------------------

test("startup migration drops an explicit-null expires_at from stored grant_json", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-absent-only-expiry-"));
  const dbPath = join(dir, "pdpp.sqlite");
  try {
    initDb(dbPath);
    // Seed the pre-normalization shape: a no-expiry grant whose blob carries
    // an explicit null, plus a real-expiry grant that must be left untouched.
    const insert = getDb().prepare(
      `INSERT INTO grants(grant_id, subject_id, client_id, grant_json, access_mode, issued_at, expires_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      "grt_legacy_null",
      "owner-1",
      "client-1",
      JSON.stringify({ access_mode: "continuous", expires_at: null, grant_id: "grt_legacy_null" }),
      "continuous",
      "2026-08-11T12:00:00Z",
      null
    );
    insert.run(
      "grt_real_expiry",
      "owner-1",
      "client-1",
      JSON.stringify({
        access_mode: "single_use",
        expires_at: "2027-04-06T00:00:00Z",
        grant_id: "grt_real_expiry",
      }),
      "single_use",
      "2026-08-11T12:00:00Z",
      "2027-04-06T00:00:00Z"
    );
    closeDb();

    // Re-open: the startup migration runs against the persisted rows.
    initDb(dbPath);
    const rows = getDb().prepare("SELECT grant_id, grant_json FROM grants ORDER BY grant_id").all() as Array<{
      grant_id: string;
      grant_json: string;
    }>;
    const byId = new Map(rows.map((row) => [row.grant_id, JSON.parse(row.grant_json)]));

    const migrated = byId.get("grt_legacy_null");
    assert.ok(migrated);
    assert.equal("expires_at" in migrated, false, "explicit null must be removed from the stored blob");
    assert.equal(migrated.access_mode, "continuous", "the rest of the grant must survive");

    const untouched = byId.get("grt_real_expiry");
    assert.ok(untouched);
    assert.equal(untouched.expires_at, "2027-04-06T00:00:00Z", "a real expiry must never be dropped");

    // Idempotent: a second boot is a no-op.
    closeDb();
    initDb(dbPath);
    const again = getDb().prepare("SELECT grant_json FROM grants WHERE grant_id = ?").get("grt_legacy_null") as {
      grant_json: string;
    };
    assert.equal("expires_at" in JSON.parse(again.grant_json), false);
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});

// --- 2. unknown error codes are opaque to clients -----------------------

test("an unrecognized error code stays opaque while status class and type remain usable", () => {
  // A code no version of this client has ever seen, delivered on a mapped status.
  const body = {
    error: {
      code: "some_future_code_this_client_has_never_seen",
      message: "Grant does not include stream 'messages'.",
      request_id: "req_01JQXA3N9Y",
      type: "permission_error",
    },
  };

  const error = new PdppHttpError(body.error.message, 403, body);

  // The client must not fail on, or branch over, the unknown code: it is
  // carried through untouched as part of the opaque body.
  assert.equal(error.status, 403);
  assert.equal((error.body as typeof body).error.code, "some_future_code_this_client_has_never_seen");

  // Status class and error `type` are what the client actually acts on.
  assert.equal(typeFor(error.status), "permission_error");
  assert.equal((error.body as typeof body).error.type, "permission_error");
  assert.equal(error.exitCode, 4, "403 must map to its status-class exit code, not to the unknown code");
  assert.equal(error.message, "Grant does not include stream 'messages'.");
});

test("an unknown code on an unmapped status still falls back to a usable class", () => {
  const error = new PdppHttpError("Teapot", 418, {
    error: { code: "totally_unknown", message: "Teapot", type: "api_error" },
  });
  assert.equal(error.status, 418);
  assert.equal(typeFor(error.status), "api_error");
  assert.equal(error.exitCode, 1);
});

test("client status-class handling is identical for known and unknown codes", () => {
  // The conformance property: swapping a known code for an unknown one changes
  // nothing about how the client dispositions the response.
  const known = new PdppHttpError("m", 403, { error: { code: "grant_stream_not_allowed", type: "permission_error" } });
  const unknown = new PdppHttpError("m", 403, { error: { code: "not_yet_invented", type: "permission_error" } });

  assert.equal(known.status, unknown.status);
  assert.equal(known.exitCode, unknown.exitCode);
  assert.equal(typeFor(known.status), typeFor(unknown.status));
});
