// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Client conformance proof and injected-defect receipts.
//
// The clean run proves the suite's synthetic client (not a shipped client) can
// perform the named actions. The paired defect run changes exactly one client
// behavior and must fail the same case. This is independent evidence for the
// oracle: a case that passes both runs does not distinguish a conforming client
// from the deliberately violating behavior.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ClientDefect, createPdppClientUnderTest } from "../src/harness/client-adapter.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import { CLIENT_CASES } from "../src/tests/client.ts";
import { CLIENT_DISCRIMINATION_MATRIX } from "./fixtures/proof-registry.ts";

function caseById(caseId: string) {
  const conformanceCase = CLIENT_CASES.find((candidate) => candidate.caseId === caseId);
  assert.ok(conformanceCase, `No client case with id ${caseId}`);
  return conformanceCase;
}

async function runClientCase(caseId: string, defects: readonly ClientDefect[]) {
  const client = await createPdppClientUnderTest(defects);
  const target = new ReferenceTargetAdapter();
  try {
    return await runCase(caseById(caseId), { ...makeContext(target, []), client });
  } finally {
    await client.fixture.close();
  }
}

describe("client cases pass against the synthetic client adapter and fail injected defects", () => {
  for (const { caseId, defect } of CLIENT_DISCRIMINATION_MATRIX) {
    it(`${caseId} has a discriminating receipt for ${defect}`, async () => {
      const clean = await runClientCase(caseId, []);
      assert.equal(clean.outcome, "pass", `${caseId} clean run: ${clean.detail ?? "(no detail)"}`);

      const violating = await runClientCase(caseId, [defect]);
      assert.equal(
        violating.outcome,
        "fail",
        `${caseId} accepted injected defect ${defect}; observed: ${violating.detail ?? "(no detail)"}`
      );
      assert.ok(violating.detail, `${caseId} failed without reviewable receipt detail`);
    });
  }
});

it("CL-8/reads-source-kind-from-grant is unsupported for a client with no provenance-dependent policy", async () => {
  const client = await createPdppClientUnderTest([], { declaresProvenancePolicy: false });
  const target = new ReferenceTargetAdapter();
  try {
    const result = await runCase(caseById("CL-8/reads-source-kind-from-grant"), {
      ...makeContext(target, []),
      client,
    });
    assert.equal(result.outcome, "unsupported", result.detail ?? "(no detail)");
  } finally {
    await client.fixture.close();
  }
});
