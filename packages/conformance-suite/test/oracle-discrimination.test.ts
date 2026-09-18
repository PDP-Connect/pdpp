// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The suite's own oracle-discrimination proof.
//
// Protected risk: a conformance oracle that can never fail. An assertion whose
// failure branch is unreachable — a typo'd parameter name, a status check that
// matches everything, an evidence path that throws before asserting — passes
// against every target and certifies nothing. This is the specific defect that
// makes a conformance suite actively harmful rather than merely incomplete,
// because the resulting green report is taken as evidence.
//
// The oracle: each negative case is run twice against a real HTTP server — once
// against a clean reference target (must pass) and once against the same server
// with the one defect that violates that case's requirement (must fail). A case
// that passes both runs cannot discriminate and is reported as broken.
//
// Why a cheaper test is insufficient: asserting on the case's source, or unit
// testing its helper functions, cannot show that the assembled request/response
// path actually reaches the failure branch. Only executing it against a
// deliberately violating server does, and the violating server is the
// independent truth source (its defects are declared as behaviour, not derived
// from the test's expectations).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConformanceCase } from "../src/harness/runner.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import type { Defect } from "../src/targets/reference-server.ts";
import { GRANT_LIFECYCLE_CASES } from "../src/tests/grant-lifecycle.ts";
import { QUERY_SURFACE_CASES } from "../src/tests/query-surface.ts";
import { RESOURCE_SERVER_CASES } from "../src/tests/resource-server.ts";
import { SELECTION_VALIDATION_CASES } from "../src/tests/selection-validation.ts";

const CASES: readonly ConformanceCase[] = [
  ...RESOURCE_SERVER_CASES,
  ...GRANT_LIFECYCLE_CASES,
  ...QUERY_SURFACE_CASES,
  ...SELECTION_VALIDATION_CASES,
];

function caseById(caseId: string): ConformanceCase {
  const found = CASES.find((c) => c.caseId === caseId);
  assert.ok(found, `No case with id ${caseId}`);
  return found;
}

async function runAgainst(caseId: string, defects: readonly Defect[]): Promise<{ outcome: string; detail?: string }> {
  const adapter = new ReferenceTargetAdapter(undefined, new Set(defects));
  const { streams } = await adapter.setup();
  try {
    const result = await runCase(caseById(caseId), makeContext(adapter, streams));
    return result.detail === undefined
      ? { outcome: result.outcome }
      : { outcome: result.outcome, detail: result.detail };
  } finally {
    await adapter.teardown();
  }
}

/**
 * Each row pairs a case with the single defect that violates its requirement.
 * The defect is named independently of the case's assertion text, so a case
 * rewritten to assert something else stops discriminating and this test fails.
 */
const DISCRIMINATION_MATRIX: readonly {
  readonly caseId: string;
  readonly defect: Defect;
}[] = [
  { caseId: "RS-2/ungranted-stream-refused", defect: "ignore-grant-streams" },
  {
    caseId: "RS-2/field-projection-not-exceeded",
    defect: "ignore-field-projection",
  },
  {
    caseId: "RS-9/client-token-exact-filter-rejected",
    defect: "accept-client-filters",
  },
  { caseId: "RS-10/unknown-parameter-rejected", defect: "ignore-unknown-params" },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "truncate-owner-metadata",
  },
  {
    caseId: "RS-15/client-metadata-projection-closed",
    defect: "leak-current-metadata",
  },
  {
    caseId: "RS-16/401-carries-resource-metadata-challenge",
    defect: "weak-401-challenge",
  },
  { caseId: "AS-8/revoked-grant-refused", defect: "ignore-revocation" },
  // Added after independent review: these three are negative-shaped oracles
  // (they exist to catch a cross-subject leak, a fake self-export declaration,
  // and syntax-derived token kind) and previously had only a passes-clean
  // control, which does not show the assertion can fire.
  {
    caseId: "RS-4/token-kind-not-inferred-from-syntax",
    defect: "infer-token-kind-from-syntax",
  },
  { caseId: "RS-12/foreign-subject-cannot-read", defect: "ignore-subject-scope" },
  {
    caseId: "RS-6/ungranted-stream-error-classification",
    defect: "misclassify-stream-denial",
  },
  { caseId: "RS-6/malformed-cursor-rejected", defect: "crash-on-bad-cursor" },
  {
    caseId: "RS-10/oversized-limit-clamped-with-warning",
    defect: "silent-limit-clamp",
  },
  {
    caseId: "RS-13/self-export-supported",
    defect: "declare-self-export-but-refuse",
  },
  // Selection-time validation. Each defect models the server taking the
  // client's word for something the retained declaration is supposed to settle.
  {
    caseId: "AS-2/undeclared-stream-refused",
    defect: "accept-undeclared-selection",
  },
  {
    caseId: "AS-2/undeclared-field-refused",
    defect: "accept-undeclared-selection",
  },
  {
    caseId: "AS-2/unrecognized-preset-refused",
    defect: "accept-undeclared-selection",
  },
  {
    caseId: "AS-5/both-streams-and-preset-refused",
    defect: "accept-malformed-selection",
  },
  {
    caseId: "AS-5/neither-streams-nor-preset-refused",
    defect: "accept-malformed-selection",
  },
  // AS-6 is the inverted one: the defect is OVER-refusal, so the violating
  // target rejects a request the clean one accepts.
  {
    caseId: "AS-6/unregistered-purpose-not-rejected",
    defect: "reject-unregistered-purpose",
  },
  {
    caseId: "AS-17/unsupported-version-rejected",
    defect: "accept-unsupported-version",
  },
];

describe("negative oracles discriminate conforming from violating targets", () => {
  for (const { caseId, defect } of DISCRIMINATION_MATRIX) {
    it(`${caseId} passes a clean target and fails one with defect "${defect}"`, async () => {
      const clean = await runAgainst(caseId, []);
      assert.equal(
        clean.outcome,
        "pass",
        `${caseId} did not pass against the clean reference target: ${clean.detail ?? "(no detail)"}`
      );

      const violating = await runAgainst(caseId, [defect]);
      assert.equal(
        violating.outcome,
        "fail",
        `${caseId} did not fail against a target with defect "${defect}". The oracle cannot distinguish a conforming target from a violating one, so its passes carry no evidence.`
      );
      assert.ok(
        violating.detail && violating.detail.length > 0,
        `${caseId} failed without a detail; a failure with no explanation is not reviewable evidence.`
      );
    });
  }
});

describe("positive controls hold", () => {
  // Without these, "fails against the defect" could be satisfied by a case that
  // fails against everything, which is equally useless.
  for (const caseId of [
    "RS-1/list-streams-envelope",
    "RS-2/granted-stream-readable",
    "RS-11/unsupported-version-rejected",
    "RS-16/unauthenticated-request-refused",
    "RS-16/protected-resource-metadata-published",
  ]) {
    it(`${caseId} passes against the clean reference target`, async () => {
      const result = await runAgainst(caseId, []);
      assert.equal(result.outcome, "pass", `${caseId}: ${result.detail ?? "(no detail)"}`);
    });
  }
});
