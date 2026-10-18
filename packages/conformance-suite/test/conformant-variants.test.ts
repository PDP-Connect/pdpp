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
import type { DeclarationOutcome, GrantRequest, StagedApproval, TargetAdapter } from "../src/harness/adapter.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ALL_CASES } from "../src/suite.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import type { Defect } from "../src/targets/reference-server.ts";

const MAKE_STALE_HOOK = /makeStale/;
const SHARED_CREDENTIAL_HOOK = /issueSharedCredentialGrants/;

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

describe("a target that binds one credential to one grant", () => {
  class OneCredentialPerGrant extends ReferenceTargetAdapter {
    override issueSharedCredentialGrants() {
      return Promise.resolve(null);
    }
  }

  for (const caseId of [
    "AS-26/ending-one-grant-spares-the-shared-credential",
    "AS-8/shared-credential-inactive-only-when-no-grant-is-active",
  ]) {
    it(`${caseId} skips rather than fails`, async () => {
      const conformanceCase = ALL_CASES.find((c) => c.caseId === caseId);
      assert.ok(conformanceCase);
      const adapter = new OneCredentialPerGrant();
      const { streams } = await adapter.setup();
      try {
        const result = await runCase(conformanceCase, makeContext(adapter, streams));
        assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
      } finally {
        await adapter.teardown();
      }
    });
  }

  it("a target with no hook at all names it in the skip", async () => {
    const conformanceCase = ALL_CASES.find((c) => c.caseId === "AS-26/ending-one-grant-spares-the-shared-credential");
    assert.ok(conformanceCase);
    const adapter = new ReferenceTargetAdapter();
    Reflect.deleteProperty(adapter, "issueSharedCredentialGrants");
    const hookless = Object.create(adapter, { issueSharedCredentialGrants: { value: undefined } }) as TargetAdapter;
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(conformanceCase, makeContext(hookless, streams));
      assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
      assert.match(result.detail ?? "", SHARED_CREDENTIAL_HOOK);
    } finally {
      await adapter.teardown();
    }
  });
});

describe("an authorization server that retrieves declarations only over HTTPS", () => {
  class HttpsOnly extends ReferenceTargetAdapter {
    override offerDeclarationPointer(): Promise<DeclarationOutcome> {
      return Promise.resolve({ accepted: false, status: 400, errorCode: "https_required" });
    }
  }

  for (const caseId of [
    "AS-16/declaration-retrieval-sends-no-ambient-credentials",
    "AS-16/declaration-retrieval-validates-redirect-targets",
    "AS-16/declaration-retrieval-does-not-fetch-remote-schema",
  ]) {
    it(`${caseId} skips, because the loopback fixture is not HTTPS`, async () => {
      const result = await runWith(caseId, [], () => new HttpsOnly());
      assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    });
  }
});
