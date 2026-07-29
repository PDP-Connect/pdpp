// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `rs.records.ingest` operation.
 *
 * Spec: openspec/changes/complete-reference-operation-refactor
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertOperationBoundary } from "./helpers/operation-boundary.ts";

const TOP_LEVEL_REGEX_1 = /\bfrom\s*['"][^'"]*\/server\/index['"]/;
const TOP_LEVEL_REGEX_2 = /\bfrom\s*['"][^'"]*\/server\/records['"]/;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function read(rel: string) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

const OP_REL = "reference-implementation/operations/rs-records-ingest/index.ts";

test("rs.records.ingest operation has no host or storage concretes", () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test("rs.records.ingest operation does not import server/index.js", () => {
  const src = read(OP_REL);
  assert.equal(TOP_LEVEL_REGEX_1.test(src), false);
});

test("rs.records.ingest operation does not import server/records.js", () => {
  const src = read(OP_REL);
  assert.equal(TOP_LEVEL_REGEX_2.test(src), false);
});
