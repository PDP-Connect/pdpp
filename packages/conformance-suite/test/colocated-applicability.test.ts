// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Applicability-vs-mechanism properties for the AS-3/AS-8/AS-9 introspection
// cases.
//
// Protected risk: conflating "this case has no way to observe the requirement
// on this target" with "this requirement does not apply to this target".
// AS-3, AS-8, and AS-9 are `applicability: "always"` in the requirement
// catalogue (catalog.ts) — every authorization server, co-located or
// separated, must issue a fully-expanded grant schema (AS-3), reflect
// revocation (AS-8), and bind tokens with the PDPP introspection extension
// (AS-9). Only the MECHANISM these cases use to observe that — RFC 7662
// introspection — is unavailable on a co-located target that exposes no
// introspection endpoint (Core Section 8's local-equivalent allowance).
//
// The plausible defect is a case gating on `appliesWhen: (adapter) =>
// adapter.capabilities.separatedDeployment`, which the runner turns into
// `unsupported` and removes from `coverage.applicable` (result.ts:189,
// `applicable = total - unsupported`). That undercounts the denominator: it
// reports a co-located target as exempt from AS-3/AS-8/AS-9 rather than
// reporting that this suite version has no evidence for them there. AS-18 is
// the genuine counterexample and must keep behaving the old way: its own
// spec text ("For a separated AS and RS...") scopes the requirement itself to
// separated deployments, so `unsupported` is correct for AS-18.
//
// A cheaper test (e.g. asserting catalog.ts's `applicability` field alone)
// would miss this: the catalogue was already correct, and the defect lived
// only in how a test case's `appliesWhen` gate, plus the runner's outcome
// mapping, together confer or withhold applicability at run time.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { REQUIREMENTS } from "../src/requirements/catalog.ts";
import { ALL_CASES, runSuite } from "../src/suite.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";

describe("co-located topology does not exempt always-applicable AS requirements", () => {
  it("keeps AS-3, AS-8, and AS-9 declared applicability=always in the catalogue", () => {
    for (const id of ["AS-3", "AS-8", "AS-9"]) {
      const requirement = REQUIREMENTS.find((r) => r.id === id);
      assert.ok(requirement, `Requirement ${id} must exist in the catalogue.`);
      assert.equal(
        requirement?.applicability,
        "always",
        `${id} applies to every authorization server regardless of topology; it must not become "conditional".`
      );
    }
  });

  it("does not gate AS-3, AS-8, or AS-9 cases on separatedDeployment", () => {
    for (const id of ["AS-3", "AS-8", "AS-9"]) {
      const cases = ALL_CASES.filter((c) => c.requirementId === id);
      assert.ok(cases.length > 0, `Expected at least one case for ${id}.`);
      for (const conformanceCase of cases) {
        assert.equal(
          conformanceCase.appliesWhen,
          undefined,
          `${conformanceCase.caseId} must not use appliesWhen: gating on a topology capability reports this ` +
            "always-applicable requirement as unsupported on a co-located target, which removes it from the " +
            "applicable denominator instead of reporting missing evidence."
        );
      }
    }
  });

  it("never reports AS-3 or AS-9 as unsupported against a co-located target", async () => {
    // The assertion is `not unsupported`, not a specific outcome.
    //
    // These previously asserted "skip", which was the honest report while the
    // reference target exposed no introspection mechanism at all. It now
    // implements the local equivalent Core Section 8 permits, so they pass —
    // and pinning "skip" would have made a target improvement look like a
    // regression. What must never happen is `unsupported`: that claims the
    // requirement does not apply to a co-located deployment, which is the false
    // exemption this file exists to prevent.
    const report = await runSuite(new ReferenceTargetAdapter());
    for (const id of ["AS-3", "AS-9"]) {
      const result = report.requirements.find((r) => r.requirement.id === id);
      assert.ok(result, `Requirement ${id} must appear in the report.`);
      assert.notEqual(
        result?.outcome,
        "unsupported",
        `${id} applies to every authorization server regardless of topology. "unsupported" would remove it ` +
          "from the applicable denominator instead of reporting the evidence (or its absence) honestly."
      );
    }
  });

  it("never reports AS-8 as unsupported against a co-located target", async () => {
    const report = await runSuite(new ReferenceTargetAdapter());
    const result = report.requirements.find((r) => r.requirement.id === "AS-8");
    assert.ok(result, "Requirement AS-8 must appear in the report.");
    // As above: the outcome may now be `pass`, because the reference target
    // implements Core Section 8's local introspection equivalent. The invariant
    // is that AS-8's revocation-reflection obligation is never reported as
    // inapplicable to a co-located AS — it binds every authorization server.
    assert.notEqual(
      result?.outcome,
      "unsupported",
      "AS-8's revocation-reflection obligation applies to every AS; a co-located target is missing evidence " +
        "for it or satisfies it, never exempt from it."
    );
  });

  it("counts AS-3, AS-8, and AS-9 in the applicable denominator for a co-located target", async () => {
    const report = await runSuite(new ReferenceTargetAdapter());
    for (const id of ["AS-3", "AS-8", "AS-9"]) {
      const result = report.requirements.find((r) => r.requirement.id === id);
      assert.notEqual(
        result?.outcome,
        "unsupported",
        `${id} must not be "unsupported" on a co-located target: coverage.applicable = total - unsupported ` +
          `(result.ts), so "unsupported" here would silently shrink the denominator this requirement belongs in.`
      );
    }
  });

  it("keeps AS-18 unsupported on a co-located target: its requirement text is genuinely separated-only", async () => {
    const requirement = REQUIREMENTS.find((r) => r.id === "AS-18");
    assert.equal(
      requirement?.applicability,
      "conditional",
      "AS-18's own Section 9 text ('For a separated AS and RS...') scopes the requirement itself, unlike AS-3/8/9."
    );
    const cases = ALL_CASES.filter((c) => c.requirementId === "AS-18");
    assert.ok(cases.length > 0, "Expected at least one AS-18 case.");
    for (const conformanceCase of cases) {
      assert.equal(
        typeof conformanceCase.appliesWhen,
        "function",
        `${conformanceCase.caseId} must keep gating on separatedDeployment: AS-18 is genuinely inapplicable to ` +
          "co-located targets, not merely unobservable by this mechanism."
      );
    }

    const report = await runSuite(new ReferenceTargetAdapter());
    const result = report.requirements.find((r) => r.requirement.id === "AS-18");
    assert.equal(
      result?.outcome,
      "unsupported",
      "AS-18 against a co-located target must remain unsupported: the requirement does not apply here."
    );
  });
});
