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
import { CONSENT_ARTIFACT_CASES } from "../src/tests/consent-artifact.ts";
import { DECLARATION_TRUST_CASES } from "../src/tests/declaration-trust.ts";
import { GRANT_LIFECYCLE_CASES } from "../src/tests/grant-lifecycle.ts";
import { QUERY_SURFACE_CASES } from "../src/tests/query-surface.ts";
import { RESOURCE_SERVER_CASES } from "../src/tests/resource-server.ts";
import { SELECTION_VALIDATION_CASES } from "../src/tests/selection-validation.ts";
import { VIEW_CASES } from "../src/tests/views.ts";

const CASES: readonly ConformanceCase[] = [
  ...RESOURCE_SERVER_CASES,
  ...AUTHORIZATION_SERVER_CASES,
  ...GRANT_LIFECYCLE_CASES,
  ...QUERY_SURFACE_CASES,
  ...SELECTION_VALIDATION_CASES,
  ...VIEW_CASES,
  ...CONSENT_ARTIFACT_CASES,
  ...DECLARATION_TRUST_CASES,
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
  // The `view` and `expand_limit[...]` rows of Section 8's client-token
  // parameter table are separate clauses (8.9-3 and 8.9-5) from the filter row
  // above, and a server can honour one while rejecting another.
  //
  // `view` pairs with `serve-client-token-view`, not `accept-client-filters`,
  // and the difference was found by this test rather than reasoned about: under
  // `accept-client-filters` the reference server still refuses `view` through
  // its GENERIC unknown-parameter branch (`view` is not in KNOWN_PARAMS), so
  // the first version of this row passed a target that had never implemented
  // the client-token `view` rule. The defect below serves the view instead,
  // which is the violation clause 8.9-3 actually describes.
  {
    caseId: "RS-9/client-token-view-rejected",
    defect: "serve-client-token-view",
  },
  {
    caseId: "RS-9/client-token-expand-limit-rejected",
    defect: "accept-client-filters",
  },
  // Clause 8.9-11. Paired with a defect that accepts a GENUINE cursor under the
  // wrong direction, not with `crash-on-bad-cursor`: the cursor this case
  // replays is one the server minted moments earlier, so any oracle that only
  // validates cursor syntax would pass both runs and prove nothing.
  {
    caseId: "RS-6/order-mismatched-cursor-rejected",
    defect: "accept-order-mismatched-cursor",
  },
  { caseId: "RS-10/unknown-parameter-rejected", defect: "ignore-unknown-params" },
  {
    caseId: "RS-10/owner-filter-unknown-field-rejected",
    defect: "ignore-owner-filter-unknown-field",
  },
  {
    caseId: "RS-10/unsupported-bracketed-shape-rejected",
    defect: "ignore-unknown-params",
  },
  {
    caseId: "RS-10/owner-expand-undeclared-relation-rejected",
    defect: "ignore-owner-expand-undeclared-relation",
  },
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
  // Clause 6.8-3. Paired with `accept-malformed-stream-list` rather than
  // `accept-undeclared-selection`, because both shapes are built from names the
  // retained snapshot DOES declare: a server that validates every name against
  // the snapshot and stops there accepts them both, so the undeclared-selection
  // defect would leave these oracles passing against a violating target.
  {
    caseId: "AS-2/wildcard-beside-named-stream-refused",
    defect: "accept-malformed-stream-list",
  },
  {
    caseId: "AS-2/duplicate-stream-name-refused",
    defect: "accept-malformed-stream-list",
  },
  // ---- Core Section 5 views (clauses 5.6-2, 5.6-2a, 5.6-3, 6.8-1) ----
  //
  // Each view oracle pairs with a defect that violates ITS clause and no other.
  // That separation was checked rather than assumed: the four defects were run
  // against all four cases, and each case failed only under its own. A shared
  // defect would have left the narrower oracles passing against a target that
  // violates only the clause they are supposed to own.
  //
  // Clause 5.6-2 binds the AS's view DEFINITIONS, not a request, so its defect
  // corrupts the definition (adding a field no schema declares) rather than
  // sending a bad request — a bad request is refused for an unrelated reason
  // and would prove nothing about view validation.
  {
    caseId: "AS-12/view-within-declared-schema",
    defect: "define-view-with-undeclared-field",
  },
  // Clause 5.6-2a. The defect re-resolves the view at READ time instead of
  // serving the field list frozen at issuance, which is the only way an
  // already-approved grant can silently widen. Without it a grant's projection
  // never changes and the case would pass against a target that has no view
  // evolution at all.
  {
    caseId: "AS-13/view-evolution-does-not-widen-an-issued-grant",
    defect: "widen-existing-grants-on-view-change",
  },
  // Clause 5.6-3. The defect searches for a known view name INSIDE the supplied
  // URI — the "helpful normalization" shape of treating an opaque identifier as
  // structured. A defect that simply rejected everything would leave this
  // oracle passing for the wrong reason.
  {
    caseId: "AS-13/unrecognized-view-uri-treated-as-opaque",
    defect: "resolve-view-uri-by-substring",
  },
  // Clause 6.8-1. Both halves of the request are individually valid (a real
  // view, real declared fields), so only a server checking the COMBINATION
  // refuses it; no existing field- or name-validation defect produces this.
  {
    caseId: "AS-2/view-and-fields-mutually-exclusive",
    defect: "accept-view-and-fields-together",
  },
  // Clauses 5.2-4 and 6.8-2. The defect accepts `time_range` on a stream that
  // declares no `consent_time_field`, which is the violation both clauses name.
  // No existing defect produces it: every field- and name-validation defect
  // operates on the selection's CONTENT, while this one is about a capability
  // the stream's declaration never claimed.
  {
    caseId: "AS-2/time-range-without-consent-time-field-refused",
    defect: "accept-time-range-without-consent-time-field",
  },
  // ---- The final approval artifact (clauses 7.2-2, 6.3-2, 7.2-4) ----
  //
  // Clause 7.2-2. The defect keeps the streams and fields — the facts an
  // implementer thinks of first — and drops retention, grant expiry and the
  // resolved instance ids. A case asserting only that an artifact EXISTS passes
  // against that, which is why the oracle checks the whole field inventory.
  {
    caseId: "AS-15/final-approval-artifact-carries-resolved-terms",
    defect: "thin-approval-artifact",
  },
  // Clause 6.3-2 has two halves and a server can fail either alone, so the
  // oracle is paired with a defect for each. `mutate-bound-client-claims`
  // paraphrases the claims (violating "bound exactly");
  // `drop-client-claim-attribution` keeps them verbatim but unattributed, which
  // is the subtler failure: the text survives, and what is lost is the signal
  // that these are the client's unverifiable promises rather than enforced
  // terms. Both were confirmed to fail this case and no other.
  {
    caseId: "AS-15/rendered-client-claims-bound-with-attribution",
    defect: "mutate-bound-client-claims",
  },
  {
    caseId: "AS-15/rendered-client-claims-bound-with-attribution",
    defect: "drop-client-claim-attribution",
  },
  // Clause 7.2-4. The oracle searches the grant by claim CONTENT at any depth
  // rather than for a `client_claims` key, so a server that leaked the claims
  // under another name or nested in a stream row is caught too.
  {
    caseId: "AS-3/client-claims-stay-outside-the-resolved-grant",
    defect: "leak-client-claims-into-grant",
  },
  // ---- Declaration trust (clauses 5.8-1, 5.8-2, 5.8-4) ----
  //
  // One defect per clause, each confirmed to fail its own case and no other.
  // They have to be separate: the three obligations are checked in sequence, so
  // a shared defect would let the first refusal mask the others and leave the
  // later oracles passing against a server that never implements them.
  {
    caseId: "AS-16/unonboarded-source-authority-refused",
    defect: "accept-unonboarded-source-authority",
  },
  {
    caseId: "AS-16/provider-native-source-id-mismatch-refused",
    defect: "accept-provider-native-id-mismatch",
  },
  // The equivocation defect does the opposite of BOTH halves of 5.8-4: it
  // accepts the second document and overwrites what was retained. The oracle
  // checks both, so a server that refuses correctly but has already clobbered
  // its retained copy still fails.
  {
    caseId: "AS-16/declaration-equivocation-refused-and-prior-content-retained",
    defect: "accept-declaration-equivocation",
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
  // AS-2 field-selection validation reuses accept-undeclared-selection: the
  // reference server's exact-match field check (firstUndeclaredReason) is the
  // one path both a nonexistent field name and a dotted nested-field selector
  // fail, and that check is exactly what the defect bypasses.
  {
    caseId: "AS-2/nonexistent-field-refused",
    defect: "accept-undeclared-selection",
  },
  {
    caseId: "AS-2/dotted-nested-field-refused",
    defect: "accept-undeclared-selection",
  },
  // Clause 10.2-4. The defect changes ONLY the two cache headers: the token is
  // valid, the status is 200, and every other case still passes against it. So
  // this row is the only thing standing between the clause and an oracle that
  // would pass against a server which never set the headers at all.
  {
    caseId: "AS-9/token-response-forbids-caching",
    defect: "token-response-without-no-store",
  },
  // Clause 7.4-2, the grant-schema version axis. Paired with a defect that
  // ENFORCES the unknown-schema grant rather than with anything touching the
  // PDPP-Version header: Core forbids conflating the two axes, and a defect on
  // the header axis would let this case pass against a server that never looks
  // at `grant.version` at all — the exact violation it exists to catch.
  {
    caseId: "RS-11/unsupported-grant-schema-version-rejected",
    defect: "accept-unsupported-grant-schema-version",
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

/**
 * Fakes `replayLastCode`'s answer directly via `onReplay`, rather than
 * driving a real second token-endpoint redemption. Proves the AS-19 case
 * logic (pass/fail/skip branching on the returned shape) in isolation from
 * any transport. It does not prove a real adapter's `replayLastCode`
 * actually redeems the same code at a real token endpoint — that is
 * `vana-ps-adapter-code-replay.test.ts`'s job.
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
 * and the reference-target defect matrix above only mutates JSON/status
 * behaviour. This tiny standalone server is the independent truth source for
 * that one case: it serves the SAME upload bytes at /v1/blobs/:id in one of
 * three response modes, and the wrapped adapter's blobFixture hook points the
 * real case at it. A case that cannot tell "correct bytes" from "wrong bytes"
 * or "empty 200" would pass all three, which is exactly what this proves it
 * does not do.
 */
const CACHE_CONTROL_PATTERN = /Cache-Control/;
const LOCATION_PATTERN = /Location/;
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
    | "rejects-issued-token";

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
        const body = mode === "wrong-bytes" ? WRONG_BYTES : mode === "empty-200" ? Buffer.alloc(0) : UPLOAD_BYTES;
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
    constructor(
      private readonly inner: TargetAdapter,
      readonly baseUrl: string,
      private readonly fixture: BlobFixture
    ) {
      this.capabilities = { ...inner.capabilities, blobs: true };
      this.roles = inner.roles;
    }
    setup = () => this.inner.setup();
    teardown = () => this.inner.teardown();
    issueGrant = (r: GrantRequest) => this.inner.issueGrant(r);
    revokeGrant = (id: string) => this.inner.revokeGrant(id);
    ownerToken = () => this.inner.ownerToken();
    async blobFixture(): Promise<BlobFixture | null> {
      return this.fixture;
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
    assert.match(result.detail ?? "", /do not match/);
  });

  it("fails when the server returns an empty 200 instead of the blob", async () => {
    const result = await runBlobCase("empty-200");
    assert.equal(result.outcome, "fail");
    assert.match(result.detail ?? "", /do not match/);
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
        assert.match(result.detail ?? "", /outOfGrantBlobId/);
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
