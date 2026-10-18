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
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import type { BlobFixture, GrantRequest, IssuedGrant, StagedApproval, TargetAdapter } from "../src/harness/adapter.ts";
import type { ConformanceCase } from "../src/harness/runner.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { DEFAULT_FIXTURES, ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import type { Defect } from "../src/targets/reference-server.ts";
import { AUTHORIZATION_SERVER_CASES } from "../src/tests/authorization-server.ts";
import { CLIENT_IDENTITY_CASES } from "../src/tests/client-identity.ts";
import { CONSENT_ARTIFACT_CASES } from "../src/tests/consent-artifact.ts";
import { DECLARATION_TRUST_CASES } from "../src/tests/declaration-trust.ts";
import { DECLARATION_VALIDITY_CASES } from "../src/tests/declaration-validity.ts";
import { GRANT_LIFECYCLE_CASES, REVOCATION_TIMING } from "../src/tests/grant-lifecycle.ts";
import { MULTI_INSTANCE_CASES } from "../src/tests/multi-instance.ts";
import { QUERY_SURFACE_CASES } from "../src/tests/query-surface.ts";
import { RESOURCE_SERVER_CASES } from "../src/tests/resource-server.ts";
import { SELECTION_VALIDATION_CASES } from "../src/tests/selection-validation.ts";
import { SYNC_VISIBILITY_CASES } from "../src/tests/sync-visibility.ts";
import { TIME_RANGE_CASES } from "../src/tests/time-range.ts";
import { VIEW_CASES } from "../src/tests/views.ts";
import { TARGET_DISCRIMINATION_MATRIX } from "./fixtures/proof-registry.ts";

/** Detail-text patterns the blob cases match on, hoisted per useTopLevelRegex. */
const BYTES_DO_NOT_MATCH = /do not match/;
const OUT_OF_GRANT_BLOB_HOOK = /outOfGrantBlobId/;
const MULTI_INSTANCE_HOOK = /issueMultiInstanceGrant/;

const CASES: readonly ConformanceCase[] = [
  ...RESOURCE_SERVER_CASES,
  ...AUTHORIZATION_SERVER_CASES,
  ...GRANT_LIFECYCLE_CASES,
  ...QUERY_SURFACE_CASES,
  ...SYNC_VISIBILITY_CASES,
  ...MULTI_INSTANCE_CASES,
  ...SELECTION_VALIDATION_CASES,
  ...TIME_RANGE_CASES,
  ...VIEW_CASES,
  ...CLIENT_IDENTITY_CASES,
  ...CONSENT_ARTIFACT_CASES,
  ...DECLARATION_TRUST_CASES,
  ...DECLARATION_VALIDITY_CASES,
];

function caseById(caseId: string): ConformanceCase {
  const found = CASES.find((c) => c.caseId === caseId);
  assert.ok(found, `No case with id ${caseId}`);
  return found;
}

async function runAgainst(caseId: string, defects: readonly Defect[]): Promise<{ outcome: string; detail?: string }> {
  const adapter = new ReferenceTargetAdapter(undefined, new Set(defects));
  const { streams } = await adapter.setup();
  // The revocation case waits out the 60-second propagation ceiling before it
  // fails; shorten it so the violating run does not cost a minute.
  const savedCeiling = REVOCATION_TIMING.ceilingMs;
  if (defects.length > 0 && !defects.includes("lag-revocation-within-ceiling")) {
    REVOCATION_TIMING.ceilingMs = 1500;
  }
  try {
    const result = await runCase(caseById(caseId), makeContext(adapter, streams));
    return result.detail === undefined
      ? { outcome: result.outcome }
      : { outcome: result.outcome, detail: result.detail };
  } finally {
    REVOCATION_TIMING.ceilingMs = savedCeiling;
    await adapter.teardown();
  }
}

describe("negative oracles discriminate conforming from violating targets", () => {
  for (const { caseId, defect } of TARGET_DISCRIMINATION_MATRIX) {
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

it("AS-8/revoked-grant-refused accepts a resource server that lags revocation inside the 60-second ceiling", async () => {
  const lagged = await runAgainst("AS-8/revoked-grant-refused", ["lag-revocation-within-ceiling"]);
  assert.equal(lagged.outcome, "pass", lagged.detail ?? "(no detail)");
});

it("AS-6/unregistered-purpose-not-rejected skips, not fails, a refusal under local purpose policy", async () => {
  const result = await runAgainst("AS-6/unregistered-purpose-not-rejected", ["reject-purpose-by-local-policy"]);
  assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
});

describe("projection oracles judge the resolved allowlist, not the request", () => {
  // A narrowed request resolved to one extra field, as a schema-required field
  // forces (Core Section 7 "Note on `fields`"). That is conformant, and a hidden
  // write to the extra field legitimately appears in the delta.
  for (const caseId of [
    "RS-7/sync-eligibility-computed-on-the-authorized-projection",
    "RS-2/field-projection-not-exceeded",
  ]) {
    it(`${caseId} passes an AS that resolves the request wider than it named`, async () => {
      const result = await runAgainst(caseId, ["resolve-extra-field-into-narrowed-grant"]);
      assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
    });
  }
});

describe("RS-12 attributes a foreign 200 only to a record the seeded subject alone owns", () => {
  // Both subjects hold a stream of the same name with the same records (the
  // scope-ignoring server hands the foreign token that store, which here is also
  // the foreign subject's own). A 200 is then valid, not a leak.
  class AlikeStores extends ReferenceTargetAdapter {
    override foreignSubjectRecordIds(stream: string): Promise<readonly string[] | null> {
      const fixture = DEFAULT_FIXTURES.find((f) => f.name === stream);
      return Promise.resolve((fixture?.records ?? []).map((r) => String(r.id)));
    }
  }
  /** Same, but the adapter cannot say what the foreign store holds. */
  class UnknownForeignStore extends ReferenceTargetAdapter {
    override foreignSubjectRecordIds = undefined as never;
  }

  /** The hook exists but answers null, which the contract defines as unknown. */
  class NullForeignStore extends ReferenceTargetAdapter {
    override foreignSubjectRecordIds(): Promise<readonly string[] | null> {
      return Promise.resolve(null);
    }
  }

  async function runRs12(adapter: TargetAdapter) {
    const { streams } = await adapter.setup();
    try {
      return await runCase(caseById("RS-12/foreign-subject-cannot-read"), makeContext(adapter, streams));
    } finally {
      await adapter.teardown();
    }
  }

  it("passes when the foreign subject's own store holds the same records", async () => {
    const result = await runRs12(new AlikeStores(undefined, new Set<Defect>(["ignore-subject-scope"])));
    assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
  });

  it("skips, not fails, when the foreign store's content is unknown", async () => {
    const result = await runRs12(new UnknownForeignStore(undefined, new Set<Defect>(["ignore-subject-scope"])));
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
  });

  it("skips, not fails, when the hook exists but returns null (unknown)", async () => {
    const result = await runRs12(new NullForeignStore(undefined, new Set<Defect>(["ignore-subject-scope"])));
    assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
  });
});

it("RS-14 accepts equivalent metadata with reordered object keys", async () => {
  const adapter = new ReferenceTargetAdapter();
  const { streams } = await adapter.setup();
  try {
    // Reverse fixture object keys independently of the HTTP response.
    const reordered = JSON.parse(JSON.stringify(streams), (_key, value: unknown) => {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).reverse());
      }
      return value;
    });
    const result = await runCase(
      caseById("RS-14/owner-metadata-full-current-document"),
      makeContext(adapter, reordered)
    );
    assert.equal(result.outcome, "pass", result.detail ?? "RS-14 rejected reordered metadata");
  } finally {
    await adapter.teardown();
  }
});

it("RS-14 accepts equivalent metadata with a reordered required array", async () => {
  const adapter = new ReferenceTargetAdapter();
  const { streams } = await adapter.setup();
  try {
    const reordered = streams.map((s) => ({
      ...s,
      ...(s.expectedOwnerMetadata && {
        expectedOwnerMetadata: {
          ...s.expectedOwnerMetadata,
          ...(s.expectedOwnerMetadata.schemaRequired && {
            schemaRequired: [...s.expectedOwnerMetadata.schemaRequired].reverse(),
          }),
        },
      }),
    }));
    const result = await runCase(
      caseById("RS-14/owner-metadata-full-current-document"),
      makeContext(adapter, reordered)
    );
    assert.equal(result.outcome, "pass", result.detail ?? "RS-14 rejected a reordered required array");
  } finally {
    await adapter.teardown();
  }
});

/**
 * Wraps a real adapter to declare singleUseGrants and optionally add a
 * `reissueAgainstConsumedGrant` hook, without losing the wrapped adapter's
 * prototype methods (a `{...adapter}` object spread drops them).
 */
class SingleUseCapableAdapter implements Omit<TargetAdapter, "reissueAgainstConsumedGrant"> {
  readonly capabilities: TargetAdapter["capabilities"];
  readonly reissueAgainstConsumedGrant?: NonNullable<TargetAdapter["reissueAgainstConsumedGrant"]>;
  private readonly inner: TargetAdapter;

  constructor(
    inner: TargetAdapter,
    reissueAgainstConsumedGrant?: NonNullable<TargetAdapter["reissueAgainstConsumedGrant"]>
  ) {
    this.inner = inner;
    this.capabilities = { ...inner.capabilities, singleUseGrants: true };
    if (reissueAgainstConsumedGrant) {
      this.reissueAgainstConsumedGrant = reissueAgainstConsumedGrant;
    }
  }

  get baseUrl(): string {
    return this.inner.baseUrl;
  }
  get targetId(): string {
    return this.inner.targetId;
  }
  get targetVersion(): string {
    return this.inner.targetVersion;
  }
  get roles(): TargetAdapter["roles"] {
    return this.inner.roles;
  }
  setup(): ReturnType<TargetAdapter["setup"]> {
    return this.inner.setup();
  }
  teardown(): Promise<void> {
    return this.inner.teardown();
  }
  ownerToken(): ReturnType<TargetAdapter["ownerToken"]> {
    return this.inner.ownerToken();
  }
  // The wrapped reference adapter refuses accessMode "single_use" outright
  // (it declares no such support). Stripping the field lets it issue a real
  // grant so these tests can exercise the case's reuse logic in isolation,
  // independent of whether the reference target itself supports single_use.
  issueGrant: TargetAdapter["issueGrant"] = (request) => {
    const { accessMode: _accessMode, ...rest } = request;
    return this.inner.issueGrant(rest);
  };
  revokeGrant(grantId: string): Promise<void> {
    return this.inner.revokeGrant(grantId);
  }
}

const REISSUE_HOOK_NAME_PATTERN = /reissueAgainstConsumedGrant/;

describe("AS-10 cannot be satisfied by an unrelated new grant", () => {
  // AS-10 used to issue a second single_use grant and pass if its id differed
  // from the first, which cannot distinguish a target that atomically
  // consumes a grant from one that just mints a fresh grant every time. These
  // cases prove the corrected oracle: no evidence still means skip, and a
  // hook that reissues against a DIFFERENT grant instead of honestly
  // refusing the SAME consumed one must not pass.

  it("reports skip when the adapter has no reissueAgainstConsumedGrant hook", async () => {
    const inner = new ReferenceTargetAdapter(undefined, new Set());
    const adapter = new SingleUseCapableAdapter(inner);
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(
        caseById("AS-10/single-use-grant-consumed"),
        makeContext(adapter as TargetAdapter, streams)
      );
      assert.equal(result.outcome, "skip", `expected skip, got ${result.outcome}: ${result.detail ?? ""}`);
      assert.ok(result.detail, "skip must carry a detail");
      assert.match(result.detail, REISSUE_HOOK_NAME_PATTERN);
    } finally {
      await adapter.teardown();
    }
  });

  it("fails when the hook issues an unrelated new grant instead of refusing the consumed one", async () => {
    const inner = new ReferenceTargetAdapter(undefined, new Set());
    const adapter = new SingleUseCapableAdapter(inner, (_grantId: string) =>
      // Models the pre-fix defect: instead of proving the SAME grant id is
      // refused, this hook mints an unrelated new grant and returns it — the
      // shape a target that never atomically consumes anything can satisfy
      // trivially.
      inner.issueGrant({
        streams: DEFAULT_FIXTURES[0]
          ? [{ name: DEFAULT_FIXTURES[0].name, fields: [...DEFAULT_FIXTURES[0].fields] }]
          : [],
      })
    );
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(
        caseById("AS-10/single-use-grant-consumed"),
        makeContext(adapter as TargetAdapter, streams)
      );
      assert.equal(result.outcome, "fail", `expected fail, got ${result.outcome}: ${result.detail ?? ""}`);
    } finally {
      await adapter.teardown();
    }
  });

  it("passes when the hook proves the SAME consumed grant id is refused", async () => {
    const inner = new ReferenceTargetAdapter(undefined, new Set());
    const adapter = new SingleUseCapableAdapter(inner, (_grantId: string) => Promise.resolve(null));
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(
        caseById("AS-10/single-use-grant-consumed"),
        makeContext(adapter as TargetAdapter, streams)
      );
      assert.equal(result.outcome, "pass", `expected pass, got ${result.outcome}: ${result.detail ?? ""}`);
    } finally {
      await adapter.teardown();
    }
  });
});

/**
 * Gives the reference adapter a `stageApproval`, built on its own `issueGrant`,
 * so AS-14 can drive it: the reference adapter has no separable review step of
 * its own (`issueGrant` resolves consent out of band in one call), but the
 * consent gate this proves lives in the reference SERVER, not in this shim —
 * the shim only exposes the same decision through the two-step shape AS-14
 * needs to submit `explicitAiTrainingConsent` independently of approval.
 */
class AiTrainingStageableAdapter implements Omit<TargetAdapter, "stageApproval"> {
  readonly capabilities: TargetAdapter["capabilities"];
  private readonly inner: TargetAdapter;

  constructor(inner: TargetAdapter) {
    this.inner = inner;
    this.capabilities = inner.capabilities;
  }

  get baseUrl(): string {
    return this.inner.baseUrl;
  }
  get targetId(): string {
    return this.inner.targetId;
  }
  get targetVersion(): string {
    return this.inner.targetVersion;
  }
  get roles(): TargetAdapter["roles"] {
    return this.inner.roles;
  }
  setup(): ReturnType<TargetAdapter["setup"]> {
    return this.inner.setup();
  }
  teardown(): Promise<void> {
    return this.inner.teardown();
  }
  ownerToken(): ReturnType<TargetAdapter["ownerToken"]> {
    return this.inner.ownerToken();
  }
  issueGrant: TargetAdapter["issueGrant"] = (request) => this.inner.issueGrant(request);
  revokeGrant(grantId: string): Promise<void> {
    return this.inner.revokeGrant(grantId);
  }

  stageApproval = (wanted: GrantRequest): Promise<StagedApproval | null> => {
    let lastError: { status: number; errorCode?: string } | null = null;
    const approve = async (_revision?: string, explicitAiTrainingConsent?: boolean): Promise<IssuedGrant | null> => {
      const issued = await this.inner.issueGrant({
        ...wanted,
        ...(explicitAiTrainingConsent === undefined ? {} : { explicitAiTrainingConsent }),
      });
      lastError = issued ? null : { status: 400, errorCode: "ai_training_consent_required" };
      return issued;
    };
    return Promise.resolve({ handle: "ai-training-stage", approve, lastApproveError: () => lastError });
  };
}

describe("AS-14 cannot be satisfied by silently issuing the ai_training grant", () => {
  it("passes against a clean reference target that gates ai_training on explicit consent", async () => {
    const inner = new ReferenceTargetAdapter(undefined, new Set());
    const adapter = new AiTrainingStageableAdapter(inner);
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(
        caseById("AS-14/explicit-consent-required-for-ai-training"),
        makeContext(adapter as TargetAdapter, streams)
      );
      assert.equal(result.outcome, "pass", `expected pass, got ${result.outcome}: ${result.detail ?? ""}`);
    } finally {
      await adapter.teardown();
    }
  });

  it("fails against a target that silently issues the ai_training grant without explicit consent", async () => {
    const inner = new ReferenceTargetAdapter(undefined, new Set(["bypass-ai-training-consent"]));
    const adapter = new AiTrainingStageableAdapter(inner);
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(
        caseById("AS-14/explicit-consent-required-for-ai-training"),
        makeContext(adapter as TargetAdapter, streams)
      );
      assert.equal(result.outcome, "fail", `expected fail, got ${result.outcome}: ${result.detail ?? ""}`);
      assert.ok(result.detail && result.detail.length > 0, "failure must carry a detail");
    } finally {
      await adapter.teardown();
    }
  });
});

it("AS-14 does not pass without structured denial evidence", async () => {
  const adapter = new AiTrainingStageableAdapter(new ReferenceTargetAdapter());
  const original = adapter.stageApproval.bind(adapter);
  adapter.stageApproval = async (request) => {
    const staged = await original(request);
    return staged ? { ...staged, lastApproveError: () => null } : null;
  };
  const { streams } = await adapter.setup();
  try {
    const result = await runCase(
      caseById("AS-14/explicit-consent-required-for-ai-training"),
      makeContext(adapter, streams)
    );
    assert.equal(result.outcome, "skip");
  } finally {
    await adapter.teardown();
  }
});

it("AS-14 does not require a policy to allow AI-training grants", async () => {
  const inner = new ReferenceTargetAdapter();
  inner.issueGrant = () => Promise.resolve(null);
  const adapter = new AiTrainingStageableAdapter(inner);
  const { streams } = await adapter.setup();
  try {
    const result = await runCase(
      caseById("AS-14/explicit-consent-required-for-ai-training"),
      makeContext(adapter, streams)
    );
    assert.equal(result.outcome, "skip");
  } finally {
    await adapter.teardown();
  }
});

/**
 * Fakes `replayLastCode`'s answer directly via `onReplay`, rather than
 * driving a real second token-endpoint redemption. Proves the AS-19 case
 * logic (pass/fail/skip branching on the returned shape) in isolation from
 * any transport. It does not prove a real adapter's `replayLastCode`
 * actually redeems the same code at a real token endpoint — that is
 * outside the scope of this fixture-level oracle test.
 */
class CodeReplayStageableAdapter implements Omit<TargetAdapter, "stageApproval"> {
  private readonly inner: TargetAdapter;
  private readonly onReplay: (grantId: string) => { status: number; errorCode?: string; accessToken?: string } | null;

  readonly capabilities: TargetAdapter["capabilities"];

  constructor(
    inner: TargetAdapter,
    onReplay: (grantId: string) => { status: number; errorCode?: string; accessToken?: string } | null
  ) {
    this.inner = inner;
    this.onReplay = onReplay;
    this.capabilities = inner.capabilities;
  }

  get baseUrl(): string {
    return this.inner.baseUrl;
  }
  get targetId(): string {
    return this.inner.targetId;
  }
  get targetVersion(): string {
    return this.inner.targetVersion;
  }
  get roles(): TargetAdapter["roles"] {
    return this.inner.roles;
  }
  setup(): ReturnType<TargetAdapter["setup"]> {
    return this.inner.setup();
  }
  teardown(): Promise<void> {
    return this.inner.teardown();
  }
  ownerToken(): ReturnType<TargetAdapter["ownerToken"]> {
    return this.inner.ownerToken();
  }
  issueGrant: TargetAdapter["issueGrant"] = (request) => this.inner.issueGrant(request);
  revokeGrant(grantId: string): Promise<void> {
    return this.inner.revokeGrant(grantId);
  }

  stageApproval = (wanted: GrantRequest): Promise<StagedApproval | null> => {
    let redeemedGrantId: string | null = null;
    let redeemedOnce = false;
    const approve = async (): Promise<IssuedGrant | null> => {
      if (redeemedOnce) {
        return null;
      }
      const issued = await this.inner.issueGrant(wanted);
      if (!issued) {
        return null;
      }
      redeemedGrantId = issued.grantId;
      redeemedOnce = true;
      return issued;
    };
    const replayLastCode = (): Promise<{ status: number; errorCode?: string; accessToken?: string } | null> => {
      if (!redeemedGrantId) {
        return Promise.resolve(null);
      }
      return Promise.resolve(this.onReplay(redeemedGrantId));
    };
    return Promise.resolve({ handle: "code-replay-stage", approve, replayLastCode });
  };
}

describe("AS-19 replay oracle discriminates genuine token-endpoint code replay", () => {
  it("passes when the token endpoint refuses replay with a structured invalid_grant", async () => {
    const inner = new ReferenceTargetAdapter();
    const adapter = new CodeReplayStageableAdapter(inner, () => ({ status: 400, errorCode: "invalid_grant" }));
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(
        caseById("AS-19/authorization-code-redemption-is-not-replayable"),
        makeContext(adapter as TargetAdapter, streams)
      );
      assert.equal(result.outcome, "pass", `expected pass, got ${result.outcome}: ${result.detail ?? ""}`);
    } finally {
      await adapter.teardown();
    }
  });

  it("fails when replaying the same code issues a further access token, even under the same grant id", async () => {
    const inner = new ReferenceTargetAdapter();
    const adapter = new CodeReplayStageableAdapter(inner, () => ({ status: 200, accessToken: "second-live-token" }));
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(
        caseById("AS-19/authorization-code-redemption-is-not-replayable"),
        makeContext(adapter as TargetAdapter, streams)
      );
      assert.equal(result.outcome, "fail", `expected fail, got ${result.outcome}: ${result.detail ?? ""}`);
      assert.ok(result.detail && result.detail.length > 0, "failure must carry a detail");
    } finally {
      await adapter.teardown();
    }
  });

  it("fails on an unstructured or wrongly-coded refusal, not just any non-200", async () => {
    const inner = new ReferenceTargetAdapter();
    const adapter = new CodeReplayStageableAdapter(inner, () => ({ status: 500 }));
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(
        caseById("AS-19/authorization-code-redemption-is-not-replayable"),
        makeContext(adapter as TargetAdapter, streams)
      );
      assert.equal(result.outcome, "fail", `expected fail, got ${result.outcome}: ${result.detail ?? ""}`);
    } finally {
      await adapter.teardown();
    }
  });

  it("skips when the adapter has no replayLastCode hook", async () => {
    const inner = new ReferenceTargetAdapter();
    const adapter = new CodeReplayStageableAdapter(inner, () => ({ status: 400, errorCode: "invalid_grant" }));
    const { streams } = await adapter.setup();
    const original = adapter.stageApproval;
    adapter.stageApproval = async (request) => {
      const result = await original(request);
      if (!result) {
        return result;
      }
      return { handle: result.handle, approve: result.approve };
    };
    try {
      const result = await runCase(
        caseById("AS-19/authorization-code-redemption-is-not-replayable"),
        makeContext(adapter as TargetAdapter, streams)
      );
      assert.equal(result.outcome, "skip");
    } finally {
      await adapter.teardown();
    }
  });

  it("skips when the replay attempt is a transport failure rather than a refusal", async () => {
    const inner = new ReferenceTargetAdapter();
    const adapter = new CodeReplayStageableAdapter(inner, () => null);
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(
        caseById("AS-19/authorization-code-redemption-is-not-replayable"),
        makeContext(adapter as TargetAdapter, streams)
      );
      assert.equal(result.outcome, "skip");
    } finally {
      await adapter.teardown();
    }
  });
});

/**
 * RS-1's blob-fetch case (get-blob-bytes) needs a real byte-serving HTTP
 * endpoint to discriminate against — the in-process ReferenceServer has none,
 * and the bundled-target defect matrix above only mutates JSON/status
 * behaviour. This tiny standalone server is the independent truth source for
 * that one case: it serves the SAME upload bytes at /v1/blobs/:id in one of
 * three response modes, and the wrapped adapter's blobFixture hook points the
 * real case at it. A case that cannot tell "correct bytes" from "wrong bytes"
 * or "empty 200" would pass all three, which is exactly what this proves it
 * does not do.
 */
const CACHE_CONTROL_PATTERN = /Cache-Control/;
const LOCATION_PATTERN = /Location/;
const NOT_A_MEDIA_TYPE = /not a media type/;
const OVERBROAD_ACCESS_PATTERN = /Overbroad access/;
const UNAUTHORIZED_ACCESS_PATTERN = /Unauthorized access/;
const BEARER_TOKEN_PATTERN = /^Bearer\s+\S+/;

describe("RS-1/get-blob-bytes discriminates byte fidelity", () => {
  const UPLOAD_BYTES = Buffer.from("pdpp-conformance-blob-fixture-payload");
  const WRONG_BYTES = Buffer.from("this is not the blob you are looking for");
  const BLOB_ID = "blob_test_fixture";
  const MIME_TYPE = "application/octet-stream";

  const OUT_OF_GRANT_BLOB_ID = "blob_test_fixture_out_of_grant";

  type Mode =
    | "correct"
    | "wrong-bytes"
    | "empty-200"
    | "missing-cache-control"
    | "redirect-valid"
    | "redirect-malformed"
    | "leaks-out-of-grant-blob"
    | "enforces-out-of-grant-blob"
    | "leaks-unauthenticated"
    | "enforces-unauthenticated"
    | "deny-everything"
    | "positive-empty-bytes"
    | "rejects-issued-token"
    | "records-valid-mime"
    | "records-invalid-mime"
    | "records-no-blob-ref"
    | "records-mixed-valid-and-numeric-mime"
    | "records-numeric-mime"
    | "records-null-mime"
    | "records-blob-ref-without-mime";

  /** Set when a manual-redirect run's client follows the 302 instead of stopping at it. */
  let redirectTargetHit = false;

  async function startBlobServer(mode: Mode): Promise<{ server: Server; baseUrl: string }> {
    const server = createServer((req, res) => {
      if (req.url === "/signed-url-target") {
        redirectTargetHit = true;
        res.writeHead(200, { "content-type": MIME_TYPE }).end(UPLOAD_BYTES);
        return;
      }
      const hasBearer = BEARER_TOKEN_PATTERN.test(req.headers.authorization ?? "");
      const servePositiveBytes = () =>
        res
          .writeHead(200, {
            "content-type": MIME_TYPE,
            "content-length": String(UPLOAD_BYTES.length),
            "cache-control": "private, no-store",
          })
          .end(UPLOAD_BYTES);

      if (mode.startsWith("records-") && (req.url ?? "").startsWith("/v1/streams/")) {
        // Clause 4.8-1 binds the `blob_ref` a served record carries.
        const ref = (mime?: unknown) => ({
          blob_ref: {
            blob_id: BLOB_ID,
            size_bytes: UPLOAD_BYTES.length,
            ...(mime === undefined ? {} : { mime_type: mime }),
          },
        });
        const rows: Record<string, unknown>[] = (
          {
            "records-no-blob-ref": [{}],
            "records-invalid-mime": [ref("not a media type")],
            "records-mixed-valid-and-numeric-mime": [ref("image/png"), ref(17)],
            "records-numeric-mime": [ref(17)],
            "records-null-mime": [ref(null)],
            "records-blob-ref-without-mime": [ref()],
          } as Record<string, Record<string, unknown>[]>
        )[mode] ?? [ref("image/jpeg")];
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            object: "list",
            has_more: false,
            data: rows.map((row, i) => ({ key: `r${i}`, data: { id: `r${i}`, ...row } })),
          })
        );
        return;
      }

      if (mode === "deny-everything" || mode === "rejects-issued-token") {
        res.writeHead(mode === "rejects-issued-token" ? 401 : 403).end();
        return;
      }

      if (req.url === `/v1/blobs/${OUT_OF_GRANT_BLOB_ID}`) {
        // "enforces" refuses regardless of caller; "leaks" (the defect under
        // test) serves the out-of-grant blob to the SAME valid grant token
        // used for the in-grant fixture — Section 8 bullet 4's boundary is
        // precisely that a valid token for a DIFFERENT authorized record is
        // not enough.
        if (mode === "leaks-out-of-grant-blob") {
          servePositiveBytes();
          return;
        }
        res.writeHead(403).end();
        return;
      }

      if (req.url === `/v1/blobs/${BLOB_ID}`) {
        if (mode === "redirect-valid") {
          res.writeHead(302, { location: "/signed-url-target", "cache-control": "no-store" }).end();
          return;
        }
        if (mode === "redirect-malformed") {
          // Missing Location: Section 8 requires it on every 302, so a
          // redirect that omits it is a defect, not an untestable case.
          res.writeHead(302, { "cache-control": "no-store" }).end();
          return;
        }
        // "enforces-unauthenticated" refuses a request with no Bearer token;
        // "leaks-unauthenticated" serves the same blob without a token.
        if (mode === "enforces-unauthenticated" && !hasBearer) {
          res.writeHead(401).end();
          return;
        }
        if (mode === "leaks-unauthenticated" && !hasBearer) {
          servePositiveBytes();
          return;
        }
        if (mode === "positive-empty-bytes") {
          res
            .writeHead(200, { "content-type": MIME_TYPE, "content-length": "0", "cache-control": "private, no-store" })
            .end();
          return;
        }
        // Modes reaching here need a real authorized read of the fixture blob
        // to succeed (enforces-out-of-grant-blob, enforces-unauthenticated
        // with a Bearer token) alongside the original byte-fidelity modes.
        const overrides: Partial<Record<Mode, Buffer>> = {
          "wrong-bytes": WRONG_BYTES,
          "empty-200": Buffer.alloc(0),
        };
        const body = overrides[mode] ?? UPLOAD_BYTES;
        const headers: Record<string, string> = { "content-type": MIME_TYPE, "content-length": String(body.length) };
        if (mode !== "missing-cache-control") {
          headers["cache-control"] = "private, no-store";
        }
        res.writeHead(200, headers);
        res.end(body);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a bound TCP address");
    }
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
  }

  /** Wraps the reference adapter, pointing baseUrl/blobFixture at the tiny blob server. */
  class BlobFixtureAdapter implements TargetAdapter {
    readonly capabilities: TargetAdapter["capabilities"];
    readonly roles: TargetAdapter["roles"];
    readonly targetId = "blob-fixture-test-target";
    readonly targetVersion = "0.0.0";
    private readonly inner: TargetAdapter;
    readonly baseUrl: string;
    private readonly fixture: BlobFixture;

    constructor(inner: TargetAdapter, baseUrl: string, fixture: BlobFixture) {
      this.inner = inner;
      this.baseUrl = baseUrl;
      this.fixture = fixture;
      this.capabilities = { ...inner.capabilities, blobs: true };
      this.roles = inner.roles;
    }
    setup = () => this.inner.setup();
    teardown = () => this.inner.teardown();
    issueGrant = (r: GrantRequest) => this.inner.issueGrant(r);
    revokeGrant = (id: string) => this.inner.revokeGrant(id);
    ownerToken = () => this.inner.ownerToken();
    // Not `async` without an await: the adapter contract is async because a
    // real adapter does I/O, and this stub answers from memory.
    blobFixture(): Promise<BlobFixture | null> {
      return Promise.resolve(this.fixture);
    }
  }

  async function runBlobCase(mode: Mode, useDigest = false, caseId = "RS-1/get-blob-bytes") {
    redirectTargetHit = false;
    const { server, baseUrl } = await startBlobServer(mode);
    const inner = new ReferenceTargetAdapter();
    const { streams } = await inner.setup();
    const fixture: BlobFixture = {
      blobId: BLOB_ID,
      mimeType: MIME_TYPE,
      grantRequest: { streams: [{ name: streams[0]?.name ?? "", fields: [...(streams[0]?.fields ?? [])] }] },
      outOfGrantBlobId: OUT_OF_GRANT_BLOB_ID,
      ...(useDigest
        ? { digest: { sha256: createHash("sha256").update(UPLOAD_BYTES).digest("hex"), length: UPLOAD_BYTES.length } }
        : { rawBytes: UPLOAD_BYTES }),
    };
    const adapter = new BlobFixtureAdapter(inner, baseUrl, fixture);
    try {
      return await runCase(caseById(caseId), makeContext(adapter, streams));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await inner.teardown();
    }
  }

  it("passes when the fetched bytes match the stored upload exactly", async () => {
    const result = await runBlobCase("correct");
    assert.equal(result.outcome, "pass");
  });

  it("fails when the server returns different bytes than were stored", async () => {
    const result = await runBlobCase("wrong-bytes");
    assert.equal(result.outcome, "fail");
    assert.match(result.detail ?? "", BYTES_DO_NOT_MATCH);
  });

  it("fails when the server returns an empty 200 instead of the blob", async () => {
    const result = await runBlobCase("empty-200");
    assert.equal(result.outcome, "fail");
    assert.match(result.detail ?? "", BYTES_DO_NOT_MATCH);
  });

  it("passes using an independent sha256 digest + length instead of retained rawBytes", async () => {
    const result = await runBlobCase("correct", true);
    assert.equal(result.outcome, "pass");
  });

  it("fails a digest check when the served bytes disagree with the recorded digest", async () => {
    const result = await runBlobCase("wrong-bytes", true);
    assert.equal(result.outcome, "fail");
  });

  it("fails a direct 200 that omits Cache-Control", async () => {
    const result = await runBlobCase("missing-cache-control");
    assert.equal(result.outcome, "fail");
    assert.match(result.detail ?? "", CACHE_CONTROL_PATTERN);
  });

  it("skips a valid 302 to a signed URL without following it", async () => {
    const result = await runBlobCase("redirect-valid");
    assert.equal(result.outcome, "skip");
    assert.equal(redirectTargetHit, false);
  });

  it("fails a 302 that omits Location", async () => {
    const result = await runBlobCase("redirect-malformed");
    assert.equal(result.outcome, "fail");
    assert.match(result.detail ?? "", LOCATION_PATTERN);
    assert.equal(redirectTargetHit, false);
  });

  describe("RS-1/blob-ref-mime-type-valid reads the blob_ref a served record carries", () => {
    const CASE_ID = "RS-1/blob-ref-mime-type-valid";

    it("passes records whose blob_ref.mime_type is a media type", async () => {
      const result = await runBlobCase("records-valid-mime", false, CASE_ID);
      assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
    });

    it("fails a record whose blob_ref.mime_type is not a media type", async () => {
      const result = await runBlobCase("records-invalid-mime", false, CASE_ID);
      assert.equal(result.outcome, "fail");
      assert.match(result.detail ?? "", NOT_A_MEDIA_TYPE);
    });

    for (const mode of ["records-mixed-valid-and-numeric-mime", "records-numeric-mime", "records-null-mime"] as const) {
      it(`fails a present non-string mime_type (${mode})`, async () => {
        const result = await runBlobCase(mode, false, CASE_ID);
        assert.equal(result.outcome, "fail", result.detail ?? "(no detail)");
      });
    }

    it("skips, not passes, a blob_ref that carries no mime_type at all", async () => {
      const result = await runBlobCase("records-blob-ref-without-mime", false, CASE_ID);
      assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    });

    it("skips, not passes, when no served record carries a blob_ref", async () => {
      const result = await runBlobCase("records-no-blob-ref", false, CASE_ID);
      assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
    });
  });

  describe("RS-1/blob-redirect-response-valid binds only a redirect", () => {
    const CASE_ID = "RS-1/blob-redirect-response-valid";

    it("passes a valid 302 without following it", async () => {
      const result = await runBlobCase("redirect-valid", false, CASE_ID);
      assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
      assert.equal(redirectTargetHit, false);
    });

    it("fails a 302 that omits Location", async () => {
      const result = await runBlobCase("redirect-malformed", false, CASE_ID);
      assert.equal(result.outcome, "fail");
      assert.match(result.detail ?? "", LOCATION_PATTERN);
    });

    it("is unsupported, not passed, for a direct 200", async () => {
      const result = await runBlobCase("correct", false, CASE_ID);
      assert.equal(result.outcome, "unsupported", result.detail ?? "(no detail)");
    });
  });

  describe("RS-1/blob-outside-grant-refused discriminates authorization scoping", () => {
    const CASE_ID = "RS-1/blob-outside-grant-refused";

    it("passes when the server refuses a real blob id the grant does not reference", async () => {
      const result = await runBlobCase("enforces-out-of-grant-blob", false, CASE_ID);
      assert.equal(result.outcome, "pass");
    });

    it("fails when the server serves a blob outside the grant to a valid token", async () => {
      const result = await runBlobCase("leaks-out-of-grant-blob", false, CASE_ID);
      assert.equal(result.outcome, "fail");
      assert.match(result.detail ?? "", OVERBROAD_ACCESS_PATTERN);
    });

    it("skips when the adapter supplies no outOfGrantBlobId", async () => {
      redirectTargetHit = false;
      const { server, baseUrl } = await startBlobServer("enforces-out-of-grant-blob");
      const inner = new ReferenceTargetAdapter();
      const { streams } = await inner.setup();
      const fixture: BlobFixture = {
        blobId: BLOB_ID,
        mimeType: MIME_TYPE,
        grantRequest: { streams: [{ name: streams[0]?.name ?? "", fields: [...(streams[0]?.fields ?? [])] }] },
        rawBytes: UPLOAD_BYTES,
      };
      const adapter = new BlobFixtureAdapter(inner, baseUrl, fixture);
      try {
        const result = await runCase(caseById(CASE_ID), makeContext(adapter, streams));
        assert.equal(result.outcome, "skip");
        assert.match(result.detail ?? "", OUT_OF_GRANT_BLOB_HOOK);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await inner.teardown();
      }
    });

    // Negative controls: a server that denies (or corrupts) the positive read
    // must not be credited with enforcing the out-of-grant boundary — the
    // fail this proves is the exact defect Root flagged, where a
    // deny-everything server passed by refusing both fetches.
    it("does not pass a server that denies every blob fetch, including the fixture blob", async () => {
      const result = await runBlobCase("deny-everything", false, CASE_ID);
      assert.notEqual(result.outcome, "pass");
    });

    it("does not pass a server that returns empty bytes for the fixture blob itself", async () => {
      const result = await runBlobCase("positive-empty-bytes", false, CASE_ID);
      assert.notEqual(result.outcome, "pass");
    });
  });

  describe("RS-1/blob-unauthenticated-refused discriminates the authentication boundary", () => {
    const CASE_ID = "RS-1/blob-unauthenticated-refused";

    it("passes when the server refuses a blob fetch carrying no token", async () => {
      const result = await runBlobCase("enforces-unauthenticated", false, CASE_ID);
      assert.equal(result.outcome, "pass");
    });

    it("fails when the server serves a blob to a request carrying no token", async () => {
      const result = await runBlobCase("leaks-unauthenticated", false, CASE_ID);
      assert.equal(result.outcome, "fail");
      assert.match(result.detail ?? "", UNAUTHORIZED_ACCESS_PATTERN);
    });

    // Refusal is evidence only after this token successfully reads the blob.
    it("does not pass a server that denies every blob fetch, including the fixture blob", async () => {
      const result = await runBlobCase("deny-everything", false, CASE_ID);
      assert.notEqual(result.outcome, "pass");
    });

    it("does not pass a server that returns empty bytes for the fixture blob itself", async () => {
      const result = await runBlobCase("positive-empty-bytes", false, CASE_ID);
      assert.notEqual(result.outcome, "pass");
    });

    it("does not pass when the issued token is rejected by the positive fetch", async () => {
      const result = await runBlobCase("rejects-issued-token", false, CASE_ID);
      assert.notEqual(result.outcome, "pass");
    });
  });
});

describe("multi-instance list-records cases skip, naming the hook, on a target without it", () => {
  for (const caseId of [
    "RS-1/list-page-size-bounded-by-limit-across-instances",
    "RS-1/list-sort-order-across-instances",
    "RS-1/list-has-more-carries-next-cursor-across-instances",
    "RS-7/changes-since-accepted-on-multi-instance-grant",
  ]) {
    it(`${caseId} is skip, not pass or fail, without the hook`, async () => {
      const inner = new ReferenceTargetAdapter();
      const { streams } = await inner.setup();
      try {
        // A view over the real adapter with the hook removed; the prototype
        // method would otherwise be inherited.
        const withoutHook = Object.create(inner, { issueMultiInstanceGrant: { value: undefined } }) as TargetAdapter;
        const result = await runCase(caseById(caseId), makeContext(withoutHook, streams));
        assert.equal(result.outcome, "skip", result.detail ?? "(no detail)");
        assert.match(result.detail ?? "", MULTI_INSTANCE_HOOK);
      } finally {
        await inner.teardown();
      }
    });
  }
});

it("AS-15/final-approval-artifact-carries-resolved-terms compares the artifact with its own staged authorization, not a separate grant", async () => {
  // The staged authorization's grant and artifact agree on one expiry. A
  // separate issueGrant call reports another, as a real AS may when it computes
  // expiry at issuance. Reading facts from that second grant would fail a
  // conformant AS.
  const STAGED_EXPIRY = "2030-01-01T00:00:00Z";
  const SEPARATE_EXPIRY = "2031-01-01T00:00:00Z";
  class DivergingSeparateGrant extends ReferenceTargetAdapter {
    private expiry: string = SEPARATE_EXPIRY;

    override async issueGrant(request: GrantRequest): Promise<IssuedGrant | null> {
      const issued = await super.issueGrant(request);
      return issued && { ...issued, rawGrant: { ...(issued.rawGrant as object), expires_at: this.expiry } };
    }

    override async stageApproval(request: GrantRequest): Promise<StagedApproval | null> {
      const staged = await super.stageApproval(request);
      if (!staged) {
        return staged;
      }
      const artifact = (await staged.approvalArtifact?.()) as object;
      return {
        ...staged,
        approvalArtifact: () => Promise.resolve({ ...artifact, expires_at: STAGED_EXPIRY }),
        approve: async (...args) => {
          this.expiry = STAGED_EXPIRY;
          try {
            return await staged.approve(...args);
          } finally {
            this.expiry = SEPARATE_EXPIRY;
          }
        },
      };
    }
  }
  const adapter = new DivergingSeparateGrant();
  const { streams } = await adapter.setup();
  try {
    const result = await runCase(
      caseById("AS-15/final-approval-artifact-carries-resolved-terms"),
      makeContext(adapter, streams)
    );
    assert.equal(result.outcome, "pass", result.detail ?? "(no detail)");
  } finally {
    await adapter.teardown();
  }
});
