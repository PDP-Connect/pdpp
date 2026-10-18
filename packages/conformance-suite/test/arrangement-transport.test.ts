// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// A transport or decoding error while ARRANGING a case is missing evidence
// (`skip`); the same error from the oracle step stays a `fail`.
//
// Protected risk: a refused connection while minting a token or revoking a
// grant surfaced as "Case threw" and was counted against the target, though the
// precondition never existed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PreconditionFailed, type TargetAdapter } from "../src/harness/adapter.ts";
import { arrange, type ConformanceCase, makeContext, pass, runCase } from "../src/harness/runner.ts";
import { HttpTargetAdapter } from "../src/targets/http-target.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import { AUTHORIZATION_SERVER_CASES } from "../src/tests/authorization-server.ts";
import { CONSENT_ARTIFACT_CASES } from "../src/tests/consent-artifact.ts";
import { SELECTION_VALIDATION_CASES } from "../src/tests/selection-validation.ts";

const PATTERN_STEP_FAILED = /step failed while arranging/;
const PATTERN_STAGED_APPROVE_FAILED_WHILE_AR = /staged\.approve failed while arranging/;
const PATTERN_GENUINE_CONTROL_ARRANGING = /genuine-revision approval \(positive control\) failed while arranging/;
const PATTERN_EXPLICIT_CONTROL_ARRANGING = /explicit-consent approval \(positive control\) failed while arranging/;

const ARRANGE_SKIP = /ownerToken failed while arranging.*fetch failed/;
const ORACLE_FAIL = /Case threw: fetch failed/;
const UNREACHABLE = "http://127.0.0.1:1";

const CAPABILITIES = {
  separatedDeployment: false,
  ownerTokens: false,
  selfExport: false,
  incrementalSync: false,
  views: false,
  singleUseGrants: false,
  refreshTokens: false,
  blobs: false,
};

const httpTarget = () =>
  new HttpTargetAdapter({
    targetId: "unreachable",
    targetVersion: "0",
    baseUrl: UNREACHABLE,
    roles: ["authorization-server"],
    capabilities: CAPABILITIES,
    grants: { issueEndpoint: "/issue", revokeEndpoint: "/revoke" },
    streams: [],
  });

const transportError = () => new TypeError("fetch failed");

/** An adapter whose arrangement hook and oracle hook both throw a bare transport error. */
const throwingAdapter = {
  targetId: "fake",
  targetVersion: "0",
  baseUrl: UNREACHABLE,
  roles: ["authorization-server"],
  ownerToken: () => Promise.reject(transportError()),
  submitSelection: () => Promise.reject(transportError()),
} as unknown as TargetAdapter;

const caseCalling = (hook: "ownerToken" | "submitSelection"): ConformanceCase => ({
  caseId: `RS-1/arrangement-transport-${hook}`,
  requirementId: "RS-1",
  assertion: "test double",
  async run({ adapter }) {
    await (adapter[hook] as (...args: unknown[]) => Promise<unknown>)({});
    return pass();
  },
});

/**
 * An authorization server with one staged approval whose `approve` the test
 * supplies, so each test decides which call throws and which is refused.
 */
const approvalAdapter = (
  approve: (revision?: string, explicitConsent?: boolean) => Promise<null>,
  lastApproveError?: () => { status: number; errorCode: string }
) =>
  ({
    targetId: "fake",
    targetVersion: "0",
    baseUrl: UNREACHABLE,
    roles: ["authorization-server"],
    stageApproval: () =>
      Promise.resolve({ handle: "staged", reviewRevision: "issued-revision", approve, lastApproveError }),
  }) as unknown as TargetAdapter;

describe("transport errors while arranging a case", () => {
  it("HttpTargetAdapter.issueGrant and revokeGrant throw PreconditionFailed when the target is unreachable", async () => {
    const target = httpTarget();
    await assert.rejects(
      () => target.issueGrant({ streams: [{ name: "s", fields: ["id"] }] } as never),
      PreconditionFailed
    );
    await assert.rejects(() => target.revokeGrant("grant_1"), PreconditionFailed);
  });

  it("an arrangement hook that throws a bare transport error reports skip", async () => {
    const result = await runCase(caseCalling("ownerToken"), makeContext(throwingAdapter, []));
    assert.equal(result.outcome, "skip");
    assert.match(result.detail ?? "", ARRANGE_SKIP);
  });

  it("an oracle hook that throws the same error stays a fail", async () => {
    const result = await runCase(caseCalling("submitSelection"), makeContext(throwingAdapter, []));
    assert.equal(result.outcome, "fail");
    assert.match(result.detail ?? "", ORACLE_FAIL);
  });

  it("arrange() converts a bare throw to PreconditionFailed and leaves PreconditionFailed alone", async () => {
    await assert.rejects(
      () => arrange("step", () => Promise.reject(transportError())),
      (e: unknown) => e instanceof PreconditionFailed && PATTERN_STEP_FAILED.test(e.message)
    );
    const original = new PreconditionFailed("already classified");
    await assert.rejects(() => arrange("step", () => Promise.reject(original)), original);
  });

  it("a throwing method on a returned staged object reads skip (consent artifact approval)", async () => {
    const adapter = new ReferenceTargetAdapter();
    const { streams } = await adapter.setup();
    const staging = Object.create(adapter) as ReferenceTargetAdapter;
    staging.stageApproval = async (request) => {
      const staged = await adapter.stageApproval(request);
      if (!staged) {
        return staged;
      }
      return { ...staged, approve: () => Promise.reject(transportError()) };
    };
    try {
      const consentCase = CONSENT_ARTIFACT_CASES.find((c) => c.caseId.startsWith("AS-15/final-approval-artifact"));
      assert.ok(consentCase);
      const result = await runCase(consentCase, makeContext(staging, streams));
      assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
      assert.match(result.detail ?? "", PATTERN_STAGED_APPROVE_FAILED_WHILE_AR);
    } finally {
      await adapter.teardown();
    }
  });

  it("a throwing foreignSubjectRecordIds hook reads skip, not fail", async () => {
    const adapter = new ReferenceTargetAdapter(undefined, new Set(["ignore-subject-scope"]));
    const { streams } = await adapter.setup();
    const throwing = Object.create(adapter) as ReferenceTargetAdapter;
    throwing.foreignSubjectRecordIds = () => Promise.reject(transportError());
    try {
      const rs12 = (await import("../src/tests/resource-server.ts")).RESOURCE_SERVER_CASES.find(
        (c) => c.caseId === "RS-12/foreign-subject-cannot-read"
      );
      assert.ok(rs12);
      const result = await runCase(rs12, makeContext(throwing, streams));
      assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    } finally {
      await adapter.teardown();
    }
  });

  it("an oracle call (submitSelection) in a real case still fails on a transport error", async () => {
    const selection = SELECTION_VALIDATION_CASES.find((c) => c.caseId === "AS-2/undeclared-stream-refused");
    assert.ok(selection);
    const result = await runCase(selection, makeContext(throwingAdapter, [{ name: "s", fields: ["id"] }] as never));
    assert.equal(result.outcome, "fail");
  });

  // Positive controls are the approvals that must succeed before a refusal can
  // mean anything. A transport error there is missing evidence, so it reads skip.
  it("a transport error from the AS-15 genuine-revision control reads skip, not fail", async () => {
    const as15 = AUTHORIZATION_SERVER_CASES.find((c) => c.caseId === "AS-15/approval-requires-the-issued-revision");
    assert.ok(as15);
    // The forged revision is refused first, so the throwing call is the control.
    const adapter = approvalAdapter((revision) =>
      revision === "issued-revision" ? Promise.reject(transportError()) : Promise.resolve(null)
    );
    const result = await runCase(as15, makeContext(adapter, [{ name: "s", fields: ["id"] }] as never));
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    assert.match(result.detail ?? "", PATTERN_GENUINE_CONTROL_ARRANGING);
  });

  it("a transport error from the AS-14 explicit-consent control reads skip, not fail", async () => {
    const as14 = AUTHORIZATION_SERVER_CASES.find((c) => c.caseId === "AS-14/explicit-consent-required-for-ai-training");
    assert.ok(as14);
    // The ordinary approval is refused with a structured consent denial, so the
    // throwing call is the explicit-consent control.
    const adapter = approvalAdapter(
      (_revision, explicitConsent) => (explicitConsent ? Promise.reject(transportError()) : Promise.resolve(null)),
      () => ({ status: 400, errorCode: "ai_training_consent_required" })
    );
    const result = await runCase(as14, makeContext(adapter, [{ name: "s", fields: ["id"] }] as never));
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    assert.match(result.detail ?? "", PATTERN_EXPLICIT_CONTROL_ARRANGING);
  });

  // The negative oracle calls are the judgement itself: a transport error there
  // must stay a failed case, so the controls above cannot have widened to cover them.
  it("a transport error from the AS-15 forged-revision approval stays fail", async () => {
    const as15 = AUTHORIZATION_SERVER_CASES.find((c) => c.caseId === "AS-15/approval-requires-the-issued-revision");
    assert.ok(as15);
    const adapter = approvalAdapter(() => Promise.reject(transportError()));
    const result = await runCase(as15, makeContext(adapter, [{ name: "s", fields: ["id"] }] as never));
    assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
  });

  it("a transport error from the AS-14 ordinary approval stays fail", async () => {
    const as14 = AUTHORIZATION_SERVER_CASES.find((c) => c.caseId === "AS-14/explicit-consent-required-for-ai-training");
    assert.ok(as14);
    const adapter = approvalAdapter(() => Promise.reject(transportError()));
    const result = await runCase(as14, makeContext(adapter, [{ name: "s", fields: ["id"] }] as never));
    assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
  });
});
