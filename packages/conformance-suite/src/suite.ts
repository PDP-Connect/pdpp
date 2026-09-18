// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The suite: the set of cases, and the run that turns a target into a report.

import type { TargetAdapter } from "./harness/adapter.ts";
import type { ConformanceCase } from "./harness/runner.ts";
import { makeContext, runCases } from "./harness/runner.ts";
import { buildReport, type ConformanceReport } from "./report/result.ts";
import { AUTHORIZATION_SERVER_CASES } from "./tests/authorization-server.ts";
import { CLIENT_CASES } from "./tests/client.ts";
import { CLIENT_IDENTITY_CASES } from "./tests/client-identity.ts";
import { CONSENT_ARTIFACT_CASES } from "./tests/consent-artifact.ts";
import { DECLARATION_TRUST_CASES } from "./tests/declaration-trust.ts";
import { DECLARATION_VALIDITY_CASES } from "./tests/declaration-validity.ts";
import { GRANT_INTEGRITY_CASES } from "./tests/grant-integrity.ts";
import { GRANT_LIFECYCLE_CASES } from "./tests/grant-lifecycle.ts";
import { QUERY_SURFACE_CASES } from "./tests/query-surface.ts";
import { RESOURCE_SERVER_CASES } from "./tests/resource-server.ts";
import { SELECTION_VALIDATION_CASES } from "./tests/selection-validation.ts";
import { VIEW_CASES } from "./tests/views.ts";

/**
 * Suite version. Distinct from the spec version: the same spec revision can be
 * covered by successive suite versions as coverage grows, and a published result
 * is only comparable to another taken with the same suite version.
 */
export const SUITE = { name: "pdpp-conformance-suite", version: "0.1.0" } as const;

/** Every case the suite knows, in a stable order. */
export const ALL_CASES: readonly ConformanceCase[] = [
  ...RESOURCE_SERVER_CASES,
  ...AUTHORIZATION_SERVER_CASES,
  ...GRANT_LIFECYCLE_CASES,
  ...GRANT_INTEGRITY_CASES,
  ...SELECTION_VALIDATION_CASES,
  ...VIEW_CASES,
  ...CLIENT_IDENTITY_CASES,
  ...CONSENT_ARTIFACT_CASES,
  ...DECLARATION_TRUST_CASES,
  ...DECLARATION_VALIDITY_CASES,
  ...QUERY_SURFACE_CASES,
  ...CLIENT_CASES,
];

/**
 * Enumerate covered requirement IDs without a target.
 *
 * This is what keeps the coverage denominator honest: it answers "what does
 * this suite version claim to cover" from the case list alone, so a requirement
 * losing its last case shows up as coverage loss rather than silently vanishing.
 */
export function coveredRequirementIds(cases: readonly ConformanceCase[] = ALL_CASES): readonly string[] {
  return [...new Set(cases.map((c) => c.requirementId))].sort();
}

/**
 * Run the suite against one target.
 *
 * `SOURCE_DATE_EPOCH`, when set, fixes the run timestamps so a report is
 * byte-reproducible for anyone re-running a published submission. The report
 * records whether that held, because a reproducible claim that was not actually
 * reproducible is worse than no claim.
 */
export async function runSuite(
  adapter: TargetAdapter,
  cases: readonly ConformanceCase[] = ALL_CASES
): Promise<ConformanceReport> {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  const reproducible = Boolean(sourceDateEpoch);
  const fixedTime = sourceDateEpoch ? new Date(Number(sourceDateEpoch) * 1000).toISOString() : undefined;

  const startedAt = fixedTime ?? new Date().toISOString();
  const { streams } = await adapter.setup();
  try {
    const results = await runCases(cases, makeContext(adapter, streams));
    return buildReport({
      suite: SUITE,
      target: {
        id: adapter.targetId,
        version: adapter.targetVersion,
        baseUrl: adapter.baseUrl,
        roles: adapter.roles,
      },
      run: {
        startedAt,
        finishedAt: fixedTime ?? new Date().toISOString(),
        reproducible,
      },
      cases: results,
    });
  } finally {
    await adapter.teardown();
  }
}
