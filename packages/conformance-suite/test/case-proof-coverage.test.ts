// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Meta-test: every registered case has failure proof or an explicit review-only gap.
//
// Protected risk: a case added to the registry with no injected-defect proof.
// Such a case may be unable to fail at all, and its green result would be
// taken as evidence. The proof entries are declared data in
// `fixtures/proof-registry.ts`; this test reads them, not source text.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { it } from "node:test";
import { ALL_CASES } from "../src/suite.ts";
import {
  BESPOKE_PROOFS,
  CLIENT_DISCRIMINATION_MATRIX,
  HOOKED_DISCRIMINATION_MATRIX,
  TARGET_DISCRIMINATION_MATRIX,
} from "./fixtures/proof-registry.ts";

it("every registered case has failure proof or an explicit review-only entry", () => {
  const proven = new Set<string>([
    ...TARGET_DISCRIMINATION_MATRIX.filter((row) => !row.reviewOnly).map((row) => row.caseId),
    ...CLIENT_DISCRIMINATION_MATRIX.map((row) => row.caseId),
    ...HOOKED_DISCRIMINATION_MATRIX.map((row) => row.caseId),
    ...BESPOKE_PROOFS.map((row) => row.caseId),
  ]);
  const reviewOnly = new Set(TARGET_DISCRIMINATION_MATRIX.filter((row) => row.reviewOnly).map((row) => row.caseId));
  const missing = ALL_CASES.map((c) => c.caseId).filter((id) => !(proven.has(id) || reviewOnly.has(id)));
  assert.deepEqual(
    missing,
    [],
    `${missing.length} of ${ALL_CASES.length} cases have neither failure proof nor an explicit review-only gap:\n${missing.join("\n")}`
  );
});

it("every proof entry names a registered case", () => {
  const registered = new Set(ALL_CASES.map((c) => c.caseId));
  const stray = [
    ...TARGET_DISCRIMINATION_MATRIX,
    ...CLIENT_DISCRIMINATION_MATRIX,
    ...HOOKED_DISCRIMINATION_MATRIX,
    ...BESPOKE_PROOFS,
  ]
    .map((row) => row.caseId)
    .filter((id) => !registered.has(id));
  assert.deepEqual(stray, [], `Proof entries for unregistered cases: ${stray.join(", ")}`);
});

it("every bespoke proof names a test file that exists", () => {
  const missing = BESPOKE_PROOFS.map((row) => row.proof.split(":")[0] ?? "").filter(
    (file) => !existsSync(new URL(`./${file}`, import.meta.url))
  );
  assert.deepEqual(missing, [], `Bespoke proofs naming missing test files: ${missing.join(", ")}`);
});
