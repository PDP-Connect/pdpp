// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/pr89/gnap");

type AccessMode = "continuous" | "single_use";

interface ApprovedStream {
  fields: string[];
  instance_ids: string[];
  name: string;
  resources?: string[];
  time_constraint?: {
    field: string;
    since?: string;
    until?: string;
  };
}

interface ApprovedAuthorization {
  access_mode: AccessMode;
  source_id: string;
  streams: ApprovedStream[];
}

interface GnapFixture {
  access: ApprovedAuthorization & {
    must_understand?: string[];
    type: string;
    [key: string]: unknown;
  };
}

interface ControlMapRow {
  control: string;
  status: "GNAP-native but binding-owned" | "mapped" | "not demonstrated";
}

const CONTROL_MAP: ControlMapRow[] = [
  { control: "approved rights", status: "mapped" },
  { control: "narrowed approval", status: "mapped" },
  { control: "unknown mandatory members", status: "mapped" },
  { control: "client instance", status: "GNAP-native but binding-owned" },
  { control: "subject identity", status: "GNAP-native but binding-owned" },
  { control: "proof confirmation", status: "not demonstrated" },
  { control: "continuation interaction", status: "not demonstrated" },
];

function readFixture(name: string): GnapFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as GnapFixture;
}

function sortedUnique(values: string[], code: string): string[] {
  assert.ok(values.length > 0, code);
  assert.equal(new Set(values).size, values.length, code);
  return [...values].sort();
}

function parseGnapAccess(fixture: GnapFixture): ApprovedAuthorization {
  const { access } = fixture;
  assert.equal(access.type, "pdpp-approved-authorization");
  const mandatory = access.must_understand ?? [];
  const known = new Set(["type", "source_id", "access_mode", "streams", "must_understand"]);
  for (const member of mandatory) {
    if (!known.has(member)) {
      const error = new Error("gnap.unknown_mandatory_member") as Error & { code?: string };
      error.code = "gnap.unknown_mandatory_member";
      throw error;
    }
  }
  assert.ok(access.source_id.length > 0, "auth.source_id_empty");
  assert.ok(access.access_mode === "single_use" || access.access_mode === "continuous", "auth.access_mode_invalid");
  assert.ok(access.streams.length > 0, "auth.streams_empty");
  return {
    access_mode: access.access_mode,
    source_id: access.source_id,
    streams: access.streams.map((stream) => ({
      fields: sortedUnique(stream.fields, "auth.field_duplicate"),
      instance_ids: sortedUnique(stream.instance_ids, "auth.instance_id_duplicate"),
      name: stream.name,
      ...(stream.resources ? { resources: sortedUnique(stream.resources, "auth.resource_duplicate") } : {}),
      ...(stream.time_constraint ? { time_constraint: stream.time_constraint } : {}),
    })),
  };
}

function toGnapAccess(rights: ApprovedAuthorization): GnapFixture {
  return {
    access: {
      type: "pdpp-approved-authorization",
      ...rights,
    },
  };
}

test("GNAP approved rights round-trip without changing neutral rights", () => {
  const rights = parseGnapAccess(readFixture("approved.json"));
  assert.deepEqual(parseGnapAccess(toGnapAccess(rights)), rights);
});

test("GNAP partial approval is represented as narrowed neutral rights", () => {
  const approved = parseGnapAccess(readFixture("approved.json"));
  const partial = parseGnapAccess(readFixture("partial.json"));
  assert.equal(partial.streams.length, 1);
  assert.equal(partial.streams[0]?.name, "top_artists");
  assert.ok(approved.streams.some((stream) => stream.name === "recently_played"));
  assert.ok(!partial.streams.some((stream) => stream.name === "recently_played"));
  assert.deepEqual(parseGnapAccess(toGnapAccess(partial)), partial);
});

test("GNAP rejects unknown mandatory members", () => {
  assert.throws(() => parseGnapAccess(readFixture("unknown-mandatory.json")), {
    code: "gnap.unknown_mandatory_member",
  });
});

test("GNAP control map does not count not-demonstrated controls as passed", () => {
  assert.ok(CONTROL_MAP.some((row) => row.status === "not demonstrated"));
  assert.deepEqual(
    CONTROL_MAP.filter((row) => row.status === "not demonstrated").map((row) => row.control),
    ["proof confirmation", "continuation interaction"]
  );
});
