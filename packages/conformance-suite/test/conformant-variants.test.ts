// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Conformant variants: targets that differ from the bundled one in a way the
// specification permits. Each case below must NOT fail them.
//
// Protected risk: a false `fail` on a conformant server, which tells an
// implementer their correct choice is a violation. The oracle-discrimination
// tests prove a case can fail; these prove it does not fail what it should
// accept.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GrantRequest, StagedApproval, TargetAdapter } from "../src/harness/adapter.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ALL_CASES } from "../src/suite.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import type { Defect } from "../src/targets/reference-server.ts";

const MAKE_STALE_HOOK = /makeStale/;

async function runWith(caseId: string, defects: readonly Defect[], wrap?: (inner: TargetAdapter) => TargetAdapter) {
  const conformanceCase = ALL_CASES.find((c) => c.caseId === caseId);
  assert.ok(conformanceCase, `No case with id ${caseId}`);
  const inner = new ReferenceTargetAdapter(undefined, new Set(defects));
  const adapter = wrap ? wrap(inner) : inner;
  const { streams } = await adapter.setup();
  try {
    return await runCase(conformanceCase, makeContext(adapter, streams));
  } finally {
    await adapter.teardown();
  }
}

describe("owner filters and views are optional", () => {
  it("a target that declines owner filters reports the narrowing case unsupported, not failed", async () => {
    const result = await runWith("RS-5/owner-filter-narrows-and-never-widens", ["decline-owner-filters"]);
    assert.equal(result.outcome, "unsupported", result.detail ?? "(no detail)");
  });

  it("a target that declines owner views reports the exclusivity case unsupported, not failed", async () => {
    const result = await runWith("RS-9/owner-view-and-fields-are-mutually-exclusive", ["decline-owner-view"]);
    assert.equal(result.outcome, "unsupported", result.detail ?? "(no detail)");
  });

  it("the cursor query-shape case still passes when the owner declines views and filters", async () => {
    const result = await runWith("RS-6/page-cursor-rejected-under-another-query-shape", [
      "decline-owner-filters",
      "decline-owner-view",
    ]);
    assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
  });
});

describe("a target that cannot make a review stale", () => {
  class NoStalenessAdapter extends ReferenceTargetAdapter {
    override async stageApproval(request: GrantRequest): Promise<StagedApproval | null> {
      const staged = await super.stageApproval(request);
      if (!staged) {
        return staged;
      }
      const { makeStale: _unused, ...withoutHook } = staged;
      return withoutHook;
    }
  }

  it("reports the stale-approval case skip, naming the hook, not fail", async () => {
    const conformanceCase = ALL_CASES.find((c) => c.caseId === "AS-15/stale-review-approval-refused");
    assert.ok(conformanceCase);
    const adapter = new NoStalenessAdapter();
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(conformanceCase, makeContext(adapter, streams));
      assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
      assert.match(result.detail ?? "", MAKE_STALE_HOOK);
    } finally {
      await adapter.teardown();
    }
  });
});
