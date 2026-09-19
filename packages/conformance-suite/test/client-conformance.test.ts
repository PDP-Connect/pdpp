// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Client conformance proof and injected-defect receipts.
//
// The clean run proves the real vendored @pdpp/mcp-server RsClient wrapper can
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

const DISCRIMINATION_MATRIX: readonly { caseId: string; defect: ClientDefect }[] = [
  { caseId: "CL-2/grant-revocation-stops-further-requests", defect: "retry-revoked-grant" },
  { caseId: "CL-3/changes-since-does-not-reuse-next-cursor", defect: "reuse-next-cursor-as-changes-since" },
  { caseId: "CL-4/stores-terminal-next-changes-since", defect: "reuse-next-cursor-as-changes-since" },
  { caseId: "CL-5/full-resync-after-cursor-expired", defect: "retry-expired-cursor" },
  { caseId: "CL-5/endpoint-cursor-expiry-also-full-resyncs", defect: "retry-expired-cursor" },
  { caseId: "AS-7/client-does-not-override-display-descriptions", defect: "add-selection-display" },
  { caseId: "CL-3/forwards-cursors-as-opaque-values", defect: "construct-cursor" },
  { caseId: "CL-7/unknown-error-code-keeps-http-status-authoritative", defect: "throw-on-unknown-error" },
  { caseId: "CL-7/status-incompatible-code-does-not-override-status", defect: "override-status-with-error-code" },
  { caseId: "CL-7/unknown-error-identifiers-do-not-break-parser", defect: "parse-unknown-identifier" },
  { caseId: "CL-8/reads-source-kind-from-grant", defect: "assume-source-kind" },
];

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

describe("client cases pass against the real client adapter and fail injected defects", () => {
  for (const { caseId, defect } of DISCRIMINATION_MATRIX) {
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
