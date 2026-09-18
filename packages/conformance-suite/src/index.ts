// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Public surface of the conformance suite.
//
// This is deliberately a barrel: it is the package's published contract, and an
// implementer writing an adapter should import one name, not reach into
// internal file paths that are free to move.

export type {
  GrantRequest,
  IssuedGrant,
  SeededStream,
  TargetAdapter,
  TargetCapabilities,
} from "./harness/adapter.ts";
export type {
  ClientActionResult,
  ClientFixture,
  ClientFixtureResponse,
  ClientRequest,
  ClientSelection,
  ClientUnderTest,
} from "./harness/client-adapter.ts";
export type {
  CaseContext,
  CaseVerdict,
  ConformanceCase,
} from "./harness/runner.ts";
// biome-ignore lint/performance/noBarrelFile: this file IS the package's public API surface.
export { fail, pass, skip, unsupported } from "./harness/runner.ts";
export { renderMarkdown } from "./report/markdown.ts";
export type {
  CaseResult,
  ConformanceReport,
  Evidence,
  Outcome,
  RequirementResult,
  RoleCoverage,
} from "./report/result.ts";
export type { NormativeLevel, Requirement, Role } from "./requirements/catalog.ts";
export {
  REQUIREMENTS,
  requirementById,
  requirementsForRole,
  SPEC_SOURCE,
} from "./requirements/catalog.ts";
export { ALL_CASES, coveredRequirementIds, runSuite, SUITE } from "./suite.ts";
