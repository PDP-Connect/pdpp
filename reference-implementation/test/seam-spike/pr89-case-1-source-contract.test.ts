// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CoreSourceAuthorizationError } from "../../server/core-source-authorization.ts";
import {
  ApprovedAuthorizationError,
  parseGrantedAuthorizationDetail,
  parseResolvedGrantApprovedAuthorization,
  requireApprovedAuthorizationNarrowing,
} from "../../server/source-approved-authorization.ts";
import { writePr89CaseOutput } from "./pr89-case-output.ts";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/pr89/${name}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function firstStream(value: Record<string, unknown>): Record<string, unknown> {
  const streams = value.streams as Record<string, unknown>[];
  const [stream] = streams;
  assert.ok(stream);
  return stream;
}

function assertAuthCode(code: ApprovedAuthorizationError["code"], mutate: (value: Record<string, unknown>) => void) {
  const declaration = fixture("source.json");
  const value = fixture("rar-approved.json");
  mutate(value);
  assert.throws(
    () => parseGrantedAuthorizationDetail(value, declaration),
    (error: unknown) => error instanceof ApprovedAuthorizationError && error.code === code
  );
}

test("persisted grant and approved RAR project to equal neutral authorization", async (t) => {
  const declaration = fixture("source.json");
  const grant = fixture("grant-v01.json");
  const rar = fixture("rar-approved.json");
  const fromGrant = parseResolvedGrantApprovedAuthorization(grant, declaration);
  const fromRar = parseGrantedAuthorizationDetail(rar, declaration).authorization;

  assert.deepEqual(fromGrant, fromRar);
  assert.deepEqual(
    fromGrant.streams.map((stream) => [stream.name, stream.instance_ids, stream.fields]),
    [
      ["top_artists", ["account-a"], ["id", "name", "observed_at"]],
      ["recently_played", ["account-b"], ["id", "played_at", "title"]],
    ]
  );

  await t.test("provenance variants stay outside equality and mismatches fail before projection", () => {
    const changedBindingFacts = clone(grant);
    changedBindingFacts.client = { client_id: "different-client" };
    changedBindingFacts.subject = { id: "different-subject" };
    changedBindingFacts.grant_id = "different-grant";
    assert.deepEqual(parseResolvedGrantApprovedAuthorization(changedBindingFacts, declaration), fromGrant);

    const providerDeclaration = clone(declaration);
    (providerDeclaration.source as Record<string, unknown>).kind = "provider_native";
    const providerGrant = clone(grant);
    (providerGrant.source as Record<string, unknown>).kind = "provider_native";
    const providerRar = clone(rar);
    (providerRar.source as Record<string, unknown>).kind = "provider_native";
    assert.deepEqual(parseResolvedGrantApprovedAuthorization(providerGrant, providerDeclaration), fromGrant);
    assert.deepEqual(parseGrantedAuthorizationDetail(providerRar, providerDeclaration).authorization, fromGrant);

    const mismatched = clone(rar);
    (mismatched.source as Record<string, unknown>).kind = "provider_native";
    assert.throws(
      () => parseGrantedAuthorizationDetail(mismatched, declaration),
      (error: unknown) =>
        error instanceof CoreSourceAuthorizationError && error.code === "source.authorization_details_invalid"
    );
  });

  const invalidCases: [ApprovedAuthorizationError["code"], (value: Record<string, unknown>) => void][] = [
    [
      "auth.source_id_empty",
      (value) => {
        (value.source as Record<string, unknown>).id = "";
      },
    ],
    [
      "auth.access_mode_invalid",
      (value) => {
        value.access_mode = "read";
      },
    ],
    [
      "auth.streams_empty",
      (value) => {
        value.streams = [];
      },
    ],
    [
      "auth.stream_name_empty",
      (value) => {
        firstStream(value).name = "";
      },
    ],
    [
      "auth.stream_name_duplicate",
      (value) => {
        const streams = value.streams as Record<string, unknown>[];
        const [, second] = streams;
        assert.ok(second);
        second.name = "top_artists";
      },
    ],
    [
      "auth.instance_ids_empty",
      (value) => {
        firstStream(value).instance_ids = [];
      },
    ],
    [
      "auth.instance_id_empty",
      (value) => {
        firstStream(value).instance_ids = [""];
      },
    ],
    [
      "auth.instance_id_duplicate",
      (value) => {
        firstStream(value).instance_ids = ["account-a", "account-a"];
      },
    ],
    [
      "auth.fields_empty",
      (value) => {
        firstStream(value).fields = [];
      },
    ],
    [
      "auth.field_empty",
      (value) => {
        firstStream(value).fields = [""];
      },
    ],
    [
      "auth.field_duplicate",
      (value) => {
        firstStream(value).fields = ["id", "id"];
      },
    ],
    [
      "auth.time_constraint_invalid",
      (value) => {
        firstStream(value).time_constraint = { field: "observed_at" };
      },
    ],
    [
      "auth.time_field_changed",
      (value) => {
        const constraint = firstStream(value).time_constraint as Record<string, unknown>;
        constraint.field = "played_at";
      },
    ],
    [
      "auth.resources_empty",
      (value) => {
        firstStream(value).resources = [];
      },
    ],
    [
      "auth.resource_duplicate",
      (value) => {
        firstStream(value).resources = ["artist:42", "artist:42"];
      },
    ],
    [
      "auth.unknown_member",
      (value) => {
        firstStream(value).scope = "all";
      },
    ],
  ];
  await t.test("invalid and widening mutations return stable authorization codes", () => {
    for (const [code, mutate] of invalidCases) {
      assertAuthCode(code, mutate);
    }

    const widened = clone(fromRar);
    const [widenedStream] = widened.streams;
    assert.ok(widenedStream);
    widenedStream.instance_ids.push("account-c");
    assert.throws(
      () => requireApprovedAuthorizationNarrowing(widened, fromGrant),
      (error: unknown) => error instanceof ApprovedAuthorizationError && error.code === "auth.widened"
    );
  });

  writePr89CaseOutput({
    case_id: "case-1",
    observations: [
      "approved_authorization_equal",
      "binding_fields_excluded",
      "instance_and_field_rows_observed",
      "invalid_mutations_rejected",
    ],
    oracle_code: "equal",
    response_envelopes: [],
    schema: "pdpp.pr89.case-output.v1",
  });
});
