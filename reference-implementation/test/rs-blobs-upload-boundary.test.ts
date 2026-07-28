// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Import-boundary guards for the `rs.blobs.upload` operation.
 *
 * Spec: openspec/changes/complete-reference-operation-refactor
 *
 * The shared `operations-boundary.test.js` walks every operation module and
 * asserts the canonical forbidden-import list. This file pins the
 * operation-specific assertions: no static import of the host
 * `server/index.js` module (the Fastify host) or `server/records.js` (which
 * owns `ingestRecord`/`deleteRecord` and transitively pulls SQLite).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertOperationBoundary } from "./helpers/operation-boundary.ts";

const TOP_LEVEL_REGEX_1 = /\bfrom\s*['"][^'"]*\/server\/records['"]/;
const TOP_LEVEL_REGEX_2 = /\bfrom\s*['"][^'"]*\/server\/index['"]/;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function read(rel: string) {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

const OP_REL = "reference-implementation/operations/rs-blobs-upload/index.ts";

test("rs.blobs.upload operation has no host or storage concretes", () => {
  assertOperationBoundary(read(OP_REL), OP_REL);
});

test("rs.blobs.upload operation does not import server/index.js", () => {
  const src = read(OP_REL);
  const fromPattern = TOP_LEVEL_REGEX_2;
  assert.equal(fromPattern.test(src), false, "operation must not import the Fastify host module");
});

test("rs.blobs.upload operation does not import server/records.js", () => {
  const src = read(OP_REL);
  const fromPattern = TOP_LEVEL_REGEX_1;
  assert.equal(
    fromPattern.test(src),
    false,
    "operation must not import the native records module (which pulls SQLite and the validator)"
  );
});
