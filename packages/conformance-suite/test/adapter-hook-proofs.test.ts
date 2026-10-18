// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Oracle-discrimination proof for cases that need an adapter hook the bundled
// reference adapter deliberately does not expose to the CLI run.
//
// Protected risk: the same as `oracle-discrimination.test.ts` — an oracle that
// can never fail. AS-4 reads the reviewed grant through `reviewedStreams`, and
// AS-20 drives a refresh-token family through `issueRefreshableGrant` under a
// `refreshTokens` capability. Exposing either on the bundled target would turn
// a `skip`/`unsupported` into a `pass` in the published run, so the proof wraps
// the adapter instead. The server and its defects are the bundled ones; only
// the hook that lets the case observe them is added here.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  GrantRequest,
  RefreshableGrant,
  RefreshRefusal,
  StagedApproval,
  TargetAdapter,
} from "../src/harness/adapter.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ALL_CASES } from "../src/suite.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import type { Defect } from "../src/targets/reference-server.ts";
import { HOOKED_DISCRIMINATION_MATRIX } from "./fixtures/proof-registry.ts";

/** Exposes the reviewed grant of a staged request, read from its approval artifact. */
class ReviewReadingAdapter extends ReferenceTargetAdapter {
  private readonly reviewed = new Map<string, readonly { name: string; fields: readonly string[] }[]>();

  override async stageApproval(request: GrantRequest): Promise<StagedApproval | null> {
    const staged = await super.stageApproval(request);
    const artifact = (await staged?.approvalArtifact?.()) as
      | { streams: readonly { name: string; fields: readonly string[] }[] }
      | undefined;
    if (staged && artifact) {
      this.reviewed.set(
        staged.handle,
        artifact.streams.map((s) => ({ name: s.name, fields: [...s.fields] }))
      );
    }
    return staged;
  }

  reviewedStreams = async (handle: string) => this.reviewed.get(handle) ?? null;
}

/** Declares refresh-token support, which the bundled target does not. */
class RefreshableAdapter extends ReferenceTargetAdapter {
  override readonly capabilities = { ...new ReferenceTargetAdapter().capabilities, refreshTokens: true };
}

/** Declares single_use support, which the bundled target does not. */
class SingleUseAdapter extends ReferenceTargetAdapter {
  override readonly capabilities = { ...new ReferenceTargetAdapter().capabilities, singleUseGrants: true };
}

function build(kind: "review-reading" | "refreshable" | "single-use", defects: readonly Defect[]): TargetAdapter {
  const set = new Set(defects);
  if (kind === "review-reading") {
    return new ReviewReadingAdapter(undefined, set);
  }
  return kind === "single-use" ? new SingleUseAdapter(undefined, set) : new RefreshableAdapter(undefined, set);
}

async function run(caseId: string, kind: "review-reading" | "refreshable" | "single-use", defects: readonly Defect[]) {
  const conformanceCase = ALL_CASES.find((c) => c.caseId === caseId);
  assert.ok(conformanceCase, `No case with id ${caseId}`);
  const adapter = build(kind, defects);
  const { streams } = await adapter.setup();
  try {
    return await runCase(conformanceCase, makeContext(adapter, streams));
  } finally {
    await adapter.teardown();
  }
}

describe("hook-gated oracles discriminate conforming from violating targets", () => {
  for (const { caseId, defect, adapter } of HOOKED_DISCRIMINATION_MATRIX) {
    it(`${caseId} passes a clean target and fails one with defect "${defect}"`, async () => {
      const clean = await run(caseId, adapter, []);
      assert.equal(clean.outcome, "pass", `${caseId} clean run: ${clean.detail ?? "(no detail)"}`);

      const violating = await run(caseId, adapter, [defect]);
      assert.equal(
        violating.outcome,
        "fail",
        `${caseId} did not fail against defect "${defect}" (${violating.outcome}: ${violating.detail ?? "no detail"}). The oracle cannot tell a conforming target from a violating one.`
      );
      assert.ok(violating.detail, `${caseId} failed without a reviewable detail`);
    });
  }
});

describe("AS-20 reads the replay refusal as structured evidence", () => {
  const CASE = "AS-20/refresh-reuse-revokes-the-family";

  /** A refreshable adapter whose replay refusal is rewritten by `rewrite`. */
  async function runWithReplay(rewrite: (real: RefreshRefusal | null) => RefreshRefusal | null) {
    class Rewriting extends RefreshableAdapter {
      override async issueRefreshableGrant(request: GrantRequest): Promise<RefreshableGrant | null> {
        const grant = await super.issueRefreshableGrant(request);
        const wrap = (inner: RefreshableGrant): RefreshableGrant => ({
          ...inner,
          refresh: async (token) => {
            const result = await inner.refresh(token);
            if (result && "refreshToken" in result) {
              return wrap(result);
            }
            return rewrite(result as RefreshRefusal | null);
          },
        });
        return grant ? wrap(grant) : null;
      }
    }
    const adapter = new Rewriting();
    const conformanceCase = ALL_CASES.find((c) => c.caseId === CASE);
    assert.ok(conformanceCase);
    const { streams } = await adapter.setup();
    try {
      return await runCase(conformanceCase, makeContext(adapter, streams));
    } finally {
      await adapter.teardown();
    }
  }

  it("fails a refusal that does not return invalid_grant", async () => {
    const result = await runWithReplay(() => ({ refused: true, status: 400, errorCode: "invalid_request" }));
    assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
  });

  it("skips, not passes, a replay answered 500", async () => {
    const result = await runWithReplay(() => ({ refused: true, status: 500 }));
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
  });

  it("skips, not fails, a replay answered 404 (the token route is unavailable)", async () => {
    const result = await runWithReplay(() => ({ refused: true, status: 404 }));
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
  });

  it("passes a resource server that lags family revocation inside the 60-second ceiling", async () => {
    const adapter = new RefreshableAdapter(undefined, new Set<Defect>(["lag-revocation-within-ceiling"]));
    const conformanceCase = ALL_CASES.find((c) => c.caseId === CASE);
    assert.ok(conformanceCase);
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(conformanceCase, makeContext(adapter, streams));
      assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
    } finally {
      await adapter.teardown();
    }
  });

  it("skips a replay refusal that carries no status or code", async () => {
    const result = await runWithReplay(() => null);
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
  });
});
