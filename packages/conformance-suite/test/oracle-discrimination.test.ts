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
import type { GrantRequest, IssuedGrant, StagedApproval, TargetAdapter } from "../src/harness/adapter.ts";
import type { ConformanceCase } from "../src/harness/runner.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { DEFAULT_FIXTURES, ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import type { Defect } from "../src/targets/reference-server.ts";
import { AUTHORIZATION_SERVER_CASES } from "../src/tests/authorization-server.ts";
import { GRANT_LIFECYCLE_CASES } from "../src/tests/grant-lifecycle.ts";
import { QUERY_SURFACE_CASES } from "../src/tests/query-surface.ts";
import { RESOURCE_SERVER_CASES } from "../src/tests/resource-server.ts";
import { SELECTION_VALIDATION_CASES } from "../src/tests/selection-validation.ts";

const CASES: readonly ConformanceCase[] = [
  ...RESOURCE_SERVER_CASES,
  ...AUTHORIZATION_SERVER_CASES,
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
  // RS-14 checks five independent things (schema presence, schema content,
  // views, relationships, query capability). truncate-owner-metadata above
  // proves only schema-truncation-plus-everything-else-dropped; a mutation
  // that drops everything and fails at the schema-presence check would not
  // prove the views/relationships/query checks ever run. Each row below pairs
  // the case with a defect that corrupts exactly one category and leaves the
  // rest of the document (including schema field presence) intact, so each
  // failure is independent proof of the category's own check.
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "corrupt-owner-schema-field-type",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "omit-owner-views",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "corrupt-owner-views",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "omit-owner-relationships",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "corrupt-owner-relationships",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "omit-owner-query",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "corrupt-owner-query",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "omit-owner-schema-required-field",
  },
  {
    caseId: "RS-14/owner-metadata-full-current-document",
    defect: "corrupt-owner-schema-nested-constraint",
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
