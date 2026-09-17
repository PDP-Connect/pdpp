// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The case runner: how a conformance case declares itself and how outcomes are
// produced.
//
// A case is a value, not a function call with side effects, so the suite can
// enumerate what it WOULD run without running it. That is what makes the
// `not-tested` denominator honest: `listCases()` answers "which requirements
// does this suite version cover" without a target present.
//
// Outcome discipline is enforced here rather than trusted to each case:
//   - a case that throws is `fail` with the error as detail, never a silent pass
//   - a case whose `appliesWhen` predicate is false is `unsupported`, and the
//     body never runs, so it cannot accidentally report success
//   - a case that cannot arrange its precondition returns `skip` explicitly

import { assertRequirementExists, type CaseResult, type Evidence } from "../report/result.ts";

/** Strips one trailing slash so a declared base and a suffix do not double up. */
const TRAILING_SLASH = /\/$/;

import type { SeededStream, TargetAdapter } from "./adapter.ts";

/** What a case body receives. The adapter plus what setup() provisioned. */
export interface CaseContext {
  readonly adapter: TargetAdapter;
  /**
   * Compose a Section 8 endpoint path under the target's query base, so a case
   * never assumes a "/v1" prefix that Core does not fix. Section 8 publishes
   * `pdpp_core_query_base` precisely "so a client composes a record query
   * without assuming a version segment"; a suite that hardcoded the prefix
   * would fail a conforming server and be testing its own assumption.
   */
  path: (suffix: string) => string;
  readonly streams: readonly SeededStream[];
  /** A seeded stream by semantics, for cases that need a particular kind. */
  streamWith: (semantics: SeededStream["semantics"]) => SeededStream | undefined;
  /** Where this target publishes its RFC 9728 metadata document. */
  wellKnownPath: () => string;
}

/**
 * The verdict a case body returns.
 *
 * `skip` and `unsupported` both require a reason: an absence of evidence that
 * does not say why is indistinguishable from a bug in the suite.
 */
export type CaseVerdict =
  | { readonly outcome: "pass"; readonly evidence?: readonly Evidence[] }
  | {
      readonly outcome: "advisory";
      readonly detail: string;
      readonly evidence?: readonly Evidence[];
    }
  | {
      readonly outcome: "fail";
      readonly detail: string;
      readonly evidence?: readonly Evidence[];
    }
  | { readonly outcome: "skip"; readonly detail: string }
  | { readonly outcome: "unsupported"; readonly detail: string };

export interface ConformanceCase {
  /**
   * Gate on declared capability. When false the case is `unsupported` and the
   * body does not run. Absent means the case always applies.
   */
  appliesWhen?: (adapter: TargetAdapter) => boolean;
  /** One line stating what this case asserts. Appears in the report. */
  readonly assertion: string;
  /** Stable identifier, conventionally "<requirementId>/<slug>". */
  readonly caseId: string;
  readonly requirementId: string;
  run: (context: CaseContext) => Promise<CaseVerdict>;
}

/** Helpers so a case body reads as an assertion rather than a result literal. */
export const pass = (evidence?: readonly Evidence[]): CaseVerdict =>
  evidence ? { outcome: "pass", evidence } : { outcome: "pass" };

export const fail = (detail: string, evidence?: readonly Evidence[]): CaseVerdict =>
  evidence ? { outcome: "fail", detail, evidence } : { outcome: "fail", detail };

/**
 * The target met every MUST this case checks, but not a SHOULD it also observed.
 *
 * Reporting a SHOULD as `fail` would overstate the finding: a reader acting on it
 * would call a conforming implementation non-conformant. Reporting it as `pass`
 * would discard a real observation. This is the third thing.
 */
export const advisory = (detail: string, evidence?: readonly Evidence[]): CaseVerdict =>
  evidence ? { outcome: "advisory", detail, evidence } : { outcome: "advisory", detail };

export const skip = (detail: string): CaseVerdict => ({
  outcome: "skip",
  detail,
});

export const unsupported = (detail: string): CaseVerdict => ({
  outcome: "unsupported",
  detail,
});

/**
 * Run one case and normalise it to a CaseResult.
 *
 * The requirement ID is validated first so a typo surfaces as a loud error
 * rather than a case that silently contributes to no requirement's coverage.
 */
export async function runCase(conformanceCase: ConformanceCase, context: CaseContext): Promise<CaseResult> {
  assertRequirementExists(conformanceCase.requirementId);
  const startedAt = Date.now();

  const base = {
    caseId: conformanceCase.caseId,
    requirementId: conformanceCase.requirementId,
    assertion: conformanceCase.assertion,
  };

  if (conformanceCase.appliesWhen && !conformanceCase.appliesWhen(context.adapter)) {
    return {
      ...base,
      outcome: "unsupported",
      detail: "The target does not declare the capability this requirement is conditional on.",
      durationMs: Date.now() - startedAt,
    };
  }

  let verdict: CaseVerdict;
  try {
    verdict = await conformanceCase.run(context);
  } catch (error) {
    // A thrown error is a failed case, never a skipped one: the suite must not
    // be able to hide a broken target (or a broken case) as absence of evidence.
    verdict = fail(`Case threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  const durationMs = Date.now() - startedAt;
  return verdict.outcome === "pass"
    ? { ...base, outcome: "pass", ...(verdict.evidence && { evidence: verdict.evidence }), durationMs }
    : {
        ...base,
        outcome: verdict.outcome,
        detail: verdict.detail,
        ...("evidence" in verdict && verdict.evidence ? { evidence: verdict.evidence } : {}),
        durationMs,
      };
}

/** Run every case in order against one target. */
export async function runCases(
  cases: readonly ConformanceCase[],
  context: CaseContext
): Promise<readonly CaseResult[]> {
  const results: CaseResult[] = [];
  for (const conformanceCase of cases) {
    // Sequential by design, not by oversight: cases share one target and mutate
    // its state (issuing and revoking grants). Running them concurrently would
    // let one case's revocation surface as another's failure, so the suite
    // trades wall-clock time for attributable results.
    // biome-ignore lint/performance/noAwaitInLoops: cases share mutable target state and must not interleave.
    results.push(await runCase(conformanceCase, context));
  }
  return results;
}

export function makeContext(adapter: TargetAdapter, streams: readonly SeededStream[]): CaseContext {
  const base = (adapter.queryBase ?? "/v1").replace(TRAILING_SLASH, "");
  return {
    adapter,
    streams,
    streamWith: (semantics) => streams.find((s) => s.semantics === semantics),
    path: (suffix) => `${base}${suffix.startsWith("/") ? suffix : `/${suffix}`}`,
    wellKnownPath: () => adapter.wellKnownPath ?? "/.well-known/oauth-protected-resource",
  };
}
