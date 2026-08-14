// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const CASE_OUTPUT_SCHEMA = "pdpp.pr89.case-output.v1";
export const CASE_EVIDENCE_SCHEMA = "pdpp.pr89.case-evidence.v1";
export const RECEIPT_SCHEMA = "pdpp.pr89.receipt.v2";
export const RECEIPT_COMMAND = "pnpm --filter pdpp-reference-implementation test:seam:pr89 -- --backend postgresql";
export const FIXED_CLOCK = "2026-08-11T12:00:00Z";

export type CaseOracle =
  | "authorization_state.unsupported_legacy_shape"
  | "context_resolved"
  | "durable_handoff"
  | "equal"
  | "gnap_map"
  | "partial_approval"
  | "races_and_refresh"
  | "response_only";

export interface CaseOutput {
  case_id: CaseId;
  observations: string[];
  oracle_code: CaseOracle;
  response_envelopes: Json[];
  schema: typeof CASE_OUTPUT_SCHEMA;
}

export interface TerminalTestEvent {
  name: string;
  status: "pass";
}

export interface CaseEvidence {
  backend: "postgresql";
  case_id: CaseId;
  case_output: CaseOutput;
  case_output_digest: string;
  command: string[];
  fixtures_digest: string;
  implementation_inputs_digest: string;
  oracle_code: CaseOracle;
  schema: typeof CASE_EVIDENCE_SCHEMA;
  status: "pass";
  terminal_events: TerminalTestEvent[];
  terminal_events_digest: string;
  test_file_digest: string;
}

export interface CaseDefinition {
  fixturePaths: readonly string[];
  implementationInputPaths: readonly string[];
  observations: readonly string[];
  oracleCode: CaseOracle;
  outputRequired: boolean;
  requiredTestNames: readonly string[];
  responseEnvelopesRequired: boolean;
  testFile: string;
}

export const CASE_DEFINITIONS = {
  "case-1": {
    fixturePaths: [
      "reference-implementation/test/seam-spike/fixtures/pr89/grant-v01.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/rar-approved.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/source.json",
    ],
    implementationInputPaths: [
      "reference-implementation/server/source-approved-authorization.ts",
      "packages/reference-contract/src/public/source.ts",
      "reference-implementation/server/core-source-authorization.ts",
      "reference-implementation/server/source-declaration.ts",
    ],
    observations: [
      "approved_authorization_equal",
      "binding_fields_excluded",
      "instance_and_field_rows_observed",
      "invalid_mutations_rejected",
    ],
    oracleCode: "equal",
    outputRequired: true,
    requiredTestNames: [
      "persisted grant and approved RAR project to equal neutral authorization",
      "provenance variants stay outside equality and mismatches fail before projection",
      "invalid and widening mutations return stable authorization codes",
    ],
    responseEnvelopesRequired: false,
    testFile: "reference-implementation/test/seam-spike/pr89-case-1-source-contract.test.ts",
  },
  "case-2": {
    fixturePaths: [
      "reference-implementation/test/seam-spike/fixtures/pr89/rar-approved.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/rar-request-invalid.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/rar-request.json",
    ],
    implementationInputPaths: [
      "packages/reference-contract/src/public/source.ts",
      "reference-implementation/operations/as-consent-decision/index.ts",
      "reference-implementation/server/auth.ts",
      "reference-implementation/server/source-approved-authorization.ts",
      "reference-implementation/server/core-source-authorization.ts",
      "reference-implementation/server/routes/as-authorize.ts",
      "reference-implementation/server/routes/as-consent.ts",
      "reference-implementation/server/routes/as-oauth.ts",
      "reference-implementation/server/source-declaration.ts",
    ],
    observations: [
      "declined_stream_unqueryable",
      "partial_approval_preserved",
      "policy_terms_preserved",
      "source_error_mapped",
    ],
    oracleCode: "partial_approval",
    outputRequired: true,
    requiredTestNames: [
      "real authorization-code PKCE flow preserves narrowed approval and policy terms",
      "invalid Source selection maps to invalid_authorization_details",
    ],
    responseEnvelopesRequired: true,
    testFile: "reference-implementation/test/seam-spike/pr89-case-2-partial-approval.test.ts",
  },
  "case-3": {
    fixturePaths: [
      "reference-implementation/test/seam-spike/fixtures/pr89/rar-request.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/source.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/client-mismatch.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/expired.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/field-mismatch.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/grant-mismatch.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/inactive.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/instance-mismatch.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/rights-missing.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/source-mismatch.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/stale-cache.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/subject-mismatch.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/wrong-audience.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/wrong-context-kind.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/wrong-credentials.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/wrong-issuer.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/introspection/valid.json",
    ],
    implementationInputPaths: [
      "reference-implementation/server/core-source-authorization.ts",
      "reference-implementation/operations/as-introspect/index.ts",
      "reference-implementation/server/auth.ts",
      "reference-implementation/server/index.ts",
      "reference-implementation/server/introspection-http.ts",
      "reference-implementation/server/routes/as-oauth.ts",
      "reference-implementation/server/routes/rs-read.ts",
      "reference-implementation/server/source-approved-authorization.ts",
      "reference-implementation/server/source-introspection-context.ts",
      "reference-implementation/test/seam-spike/pr89-oauth-harness.ts",
    ],
    observations: [
      "authenticated_http_introspection",
      "complete_context_resolved",
      "mutation_matrix_rejected",
      "one_http_introspection_no_fallback",
    ],
    oracleCode: "context_resolved",
    outputRequired: true,
    requiredTestNames: ["authenticated HTTP introspection resolves context and rejects the fixed mutation matrix"],
    responseEnvelopesRequired: true,
    testFile: "reference-implementation/test/seam-spike/pr89-case-3-introspection-context.test.ts",
  },
  "case-4": {
    fixturePaths: [
      "reference-implementation/test/seam-spike/fixtures/pr89/rar-request.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/records.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/source.json",
    ],
    implementationInputPaths: [
      "reference-implementation/server/core-source-authorization.ts",
      "reference-implementation/operations/as-introspect/index.ts",
      "reference-implementation/server/auth.ts",
      "reference-implementation/server/index.ts",
      "reference-implementation/server/introspection-http.ts",
      "reference-implementation/server/record-filters.ts",
      "reference-implementation/server/records.ts",
      "reference-implementation/server/routes/as-oauth.ts",
      "reference-implementation/server/routes/rs-read.ts",
      "reference-implementation/server/source-approved-authorization.ts",
      "reference-implementation/server/source-introspection-context.ts",
      "reference-implementation/test/seam-spike/pr89-oauth-harness.ts",
    ],
    observations: ["allowed_matrix_passed", "as_disabled", "denied_matrix_passed", "response_only_enforcement"],
    oracleCode: "response_only",
    outputRequired: true,
    requiredTestNames: ["captured introspection context enforces the response-only request matrix with AS disabled"],
    responseEnvelopesRequired: true,
    testFile: "reference-implementation/test/seam-spike/pr89-case-4-response-only.test.ts",
  },
  "case-5": {
    fixturePaths: ["reference-implementation/test/seam-spike/fixtures/pr89/legacy-grant-v01.bytes"],
    implementationInputPaths: [
      "reference-implementation/server/auth.ts",
      "reference-implementation/server/credential-response-cache.ts",
      "reference-implementation/server/db.ts",
      "reference-implementation/server/postgres-storage.ts",
      "reference-implementation/server/queries/auth/oauth-authorization-codes/consume-code.sql",
      "reference-implementation/server/queries/auth/oauth-authorization-codes/get-by-code.sql",
      "reference-implementation/server/queries/auth/oauth-authorization-codes/get-by-device-code.sql",
      "reference-implementation/server/queries/auth/oauth-authorization-codes/issue-for-device-code.sql",
      "reference-implementation/server/queries/auth/oauth-authorization-codes/issue-package-for-device-code.sql",
      "reference-implementation/server/queries/auth/grant-package-members/list-all-by-package.sql",
      "reference-implementation/server/queries/auth/oauth-refresh-tokens/get-by-token.sql",
      "reference-implementation/server/queries/auth/oauth-refresh-tokens/insert.sql",
      "reference-implementation/server/queries/auth/oauth-refresh-tokens/revoke-family.sql",
      "reference-implementation/server/queries/auth/oauth-refresh-tokens/supersede-active.sql",
      "reference-implementation/server/queries/auth/tokens/get-introspection.sql",
      "reference-implementation/server/queries/auth/tokens/insert-refresh-client.sql",
      "reference-implementation/server/queries/auth/tokens/insert-refresh-mcp-package.sql",
      "reference-implementation/server/queries/auth/tokens/link-refresh-family.sql",
      "reference-implementation/server/queries/auth/tokens/revoke-by-refresh-family.sql",
      "reference-implementation/server/queries/index.ts",
      "reference-implementation/server/routes/as-oauth.ts",
      "reference-implementation/test/oauth-code-delivery-atomicity.test.ts",
      "reference-implementation/test/grant-package-postgres-path.test.ts",
      "reference-implementation/test/hosted-mcp-oauth.test.ts",
      "reference-implementation/test/token-refresh-postgres-path.test.ts",
    ],
    observations: [
      "authorization_code_race",
      "family_access_bearers_inactive",
      "fresh_authorization_required",
      "legacy_unlinked_refresh_state_rejected",
      "null_exp_omitted",
      "package_refresh_replay_contained",
      "refresh_access_expiry_bounded",
      "refresh_family_replay_revoked",
      "replay_containment_atomic",
      "single_use_race",
      "single_use_refresh_omitted",
      "supersede_failure_atomic",
    ],
    oracleCode: "races_and_refresh",
    outputRequired: false,
    requiredTestNames: ["authorization and refresh lifecycle portfolio passes on PostgreSQL"],
    responseEnvelopesRequired: false,
    testFile: "reference-implementation/test/seam-spike/pr89-case-5-lifecycle.test.ts",
  },
  "case-6": {
    fixturePaths: ["reference-implementation/test/seam-spike/fixtures/pr89/legacy-grant-v01.bytes"],
    implementationInputPaths: [
      "reference-implementation/operations/as-introspect/index.ts",
      "reference-implementation/server/auth.ts",
      "reference-implementation/server/index.ts",
      "reference-implementation/server/introspection-http.ts",
      "reference-implementation/server/routes/as-oauth.ts",
    ],
    observations: [
      "before_introspection_or_route",
      "fresh_authorization_required",
      "legacy_bytes_rejected",
      "no_reconstruction",
    ],
    oracleCode: "authorization_state.unsupported_legacy_shape",
    outputRequired: false,
    requiredTestNames: [
      "pre-contract persisted bytes are rejected by the current grant reader",
      "legacy persisted grant state fails before the SQLite RS route",
    ],
    responseEnvelopesRequired: false,
    testFile: "reference-implementation/test/persisted-authorization-state-boundary.test.ts",
  },
  "case-7": {
    fixturePaths: [
      "reference-implementation/test/seam-spike/fixtures/pr89/gnap/approved.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/gnap/partial.json",
      "reference-implementation/test/seam-spike/fixtures/pr89/gnap/unknown-mandatory.json",
    ],
    implementationInputPaths: [],
    observations: ["full_round_trip", "not_demonstrated_not_passed", "partial_narrowing", "unknown_mandatory_rejected"],
    oracleCode: "gnap_map",
    outputRequired: false,
    requiredTestNames: [
      "GNAP approved rights round-trip without changing neutral rights",
      "GNAP partial approval is represented as narrowed neutral rights",
      "GNAP rejects unknown mandatory members",
      "GNAP control map does not count not-demonstrated controls as passed",
    ],
    responseEnvelopesRequired: false,
    testFile: "reference-implementation/test/seam-spike/pr89-gnap-map.test.ts",
  },
  "case-8": {
    fixturePaths: [],
    implementationInputPaths: [
      "reference-implementation/operations/as-device-decision/index.ts",
      "reference-implementation/operations/as-consent-decision/index.ts",
      "reference-implementation/operations/as-consent-exchange/index.ts",
      "reference-implementation/server/auth.ts",
      "reference-implementation/server/db.ts",
      "reference-implementation/server/postgres-storage.ts",
      "reference-implementation/server/queries/auth/agent-connect-attempts/delete-by-id.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/delete-expired-by-id.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/delete-expired-historic-page.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/delete-expired-if-consent-terminal.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/get-expired-by-request-uri.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/get-by-id.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/insert-if-consent-pending.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/insert.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/list-expired-pending.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/list-expired-tombstones.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/mark-approved.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/mark-expired-by-id.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/mark-failed.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/prune.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/recover-approved.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/revoke-token-if-no-live-sibling.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/revoke-token.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/set-expires-at-by-id.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/set-response-json.sql",
      "reference-implementation/server/queries/auth/agent-connect-attempts/token-active.sql",
      "reference-implementation/server/queries/auth/consent-exchange-codes/get-for-redemption.sql",
      "reference-implementation/server/queries/auth/consent-exchange-codes/insert.sql",
      "reference-implementation/server/queries/auth/consent-exchange-codes/mark-redeemed.sql",
      "reference-implementation/server/queries/auth/grants/get-for-revocation.sql",
      "reference-implementation/server/queries/auth/pending-consents/mark-expired-if-due.sql",
      "reference-implementation/server/queries/index.ts",
      "reference-implementation/server/routes/as-agent-connect.ts",
      "reference-implementation/server/routes/as-consent.ts",
      "reference-implementation/test/agent-cli.test.ts",
      "reference-implementation/test/as-device-decision-outcome-pure.test.ts",
      "reference-implementation/test/auth-consent-device-postgres-path.test.ts",
      "reference-implementation/test/batch-consent-per-source-gate.test.ts",
      "reference-implementation/test/owner-device-approval-atomicity.test.ts",
      "reference-implementation/test/security-consent-token-handoff.test.ts",
    ],
    observations: [
      "approve_deny_race_single_terminal_outcome",
      "approval_commit_handoff_resume",
      "approved_after_expiry_bearer_revoked",
      "approved_cleanup_race_bearer_revoked",
      "approved_expiry_cas_bearer_revoked",
      "approved_crash_expiry_reconciled",
      "approved_crash_prune_reconciled",
      "credential_response_201_registration_no_store",
      "credential_response_200_approved_no_store",
      "credential_response_202_pending_bounded",
      "credential_response_400_expired_bounded",
      "credential_response_401_invalid_polling_code_bounded",
      "credential_response_403_denied_bounded",
      "denied_consent_projects_to_polling",
      "denied_consent_reconciles_after_completion_failure",
      "expired_consent_projects_to_polling",
      "postgres_denied_consent_recovery",
      "expired_bearer_refused",
      "invalid_bearer_redacted",
      "owner_device_concurrency_bound",
      "owner_device_cross_subject_hidden",
      "owner_device_rollback_atomic",
      "package_handoff_and_revocation",
      "postgresql_concurrent_redemption",
      "response_loss_retained_after_unrelated_registration",
      "revoked_bearer_refused",
      "single_use_bound_recovery",
      "sqlite_restart_and_response_loss",
    ],
    oracleCode: "durable_handoff",
    outputRequired: false,
    requiredTestNames: [
      "agent-cli: approved-after-expiry revokes bearer and expired bearer is refused",
      "agent-cli: cache headers reject invalid bearer without token disclosure",
      "agent-connect: denial response is bounded",
      "agent-connect: denial is durable across approval_id and completion failure",
      "agent-connect: live PostgreSQL denial is durable across approval_id and restart",
      "agent-connect: registration response is cache-safe",
      "agent-cli: cleanup/approval race revokes committed token",
      "agent-cli: crash-completed expiry and prune revoke committed approvals",
      "agent-cli: crash recovery from committed pending approval",
      "agent-cli: live PostgreSQL crash expiry/prune and response-loss replay",
      "agent-cli: live PostgreSQL approved expiry and revocation fail closed before delivery",
      "agent-cli: response-loss replay survives unrelated registration",
      "agent-cli: revoked bearer is refused before delivery",
      "auth consent device PostgreSQL: concurrent redemption and package revocation",
      "batch consent: package handoff and revocation are durable",
      "consent-exchange: SQLite restart, single-use, and response-loss recovery",
      "owner-device-approval-atomicity: rollback, owner concurrency, and cross-subject recovery",
      "terminal decisions: SQLite approval and denial arbitrate without contradictory evidence",
      "terminal decisions: live PostgreSQL approval and denial arbitrate atomically",
    ],
    responseEnvelopesRequired: false,
    testFile: "reference-implementation/test/seam-spike/pr89-case-8-durable-handoff.test.ts",
  },
} as const satisfies Record<string, CaseDefinition>;

export type CaseId = keyof typeof CASE_DEFINITIONS;

export const CASE_IDS = Object.keys(CASE_DEFINITIONS).sort() as CaseId[];
export const CASE_EXECUTION_ORDER: readonly CaseId[] = [
  "case-5",
  "case-6",
  "case-7",
  "case-8",
  "case-1",
  "case-2",
  "case-3",
  "case-4",
];

export const RECEIPT_ASSERTION_CASES = {
  authenticated_http_introspection: ["case-3"],
  durable_post_approval_handoff: ["case-8"],
  fresh_authorization_required: ["case-5", "case-6"],
  legacy_refresh_state_rejected: ["case-5"],
  no_in_process_fallback: ["case-3", "case-4"],
  postgresql_races: ["case-5"],
  refresh_family_access_tokens_inactive_on_replay: ["case-5"],
  refresh_family_revoked_on_replay: ["case-5"],
  response_only_enforcement: ["case-4"],
} as const satisfies Record<string, readonly CaseId[]>;

export const RECEIPT_DECISION_CASES = {
  approved_authorization_shape: ["case-1"],
  authorization_context_composition: ["case-3", "case-4"],
  binding_separation: ["case-1", "case-2"],
} as const satisfies Record<string, readonly CaseId[]>;

export const RECEIPT_STATIC_PATHS = [
  ".github/workflows/pr89-seam-receipt.yml",
  "design-notes/seam-spike/corpus.md",
  "openspec/changes/harden-pdpp-authorization-and-0-1-migration/design.md",
  "openspec/changes/harden-pdpp-authorization-and-0-1-migration/proposal.md",
  "openspec/changes/harden-pdpp-authorization-and-0-1-migration/specs/pdpp-authorization-hardening/spec.md",
  "openspec/changes/harden-pdpp-authorization-and-0-1-migration/tasks.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "reference-implementation/package.json",
  "reference-implementation/scripts/check-pr89-seam-receipt.test.ts",
  "reference-implementation/scripts/check-pr89-seam-receipt.ts",
  "reference-implementation/scripts/pr89-seam-evidence-contract.ts",
  "reference-implementation/scripts/run-pr89-seam.ts",
  "reference-implementation/test/seam-spike/pr89-case-output.ts",
  "reference-implementation/test/seam-spike/pr89-case-5-lifecycle.test.ts",
  "reference-implementation/test/seam-spike/artifacts/.gitignore",
  "reference-implementation/test/seam-spike/pr89-receipt.schema.json",
  "reference-implementation/test/auth-consent-device-postgres-path.test.ts",
  "reference-implementation/test/as-oauth-token-cache-headers.test.ts",
  "reference-implementation/test/batch-consent-per-source-gate.test.ts",
  "reference-implementation/test/security-consent-token-handoff.test.ts",
  "scripts/test-accounting/node-reporter.ts",
  "scripts/test-accounting/receipt.ts",
  "test-accounting.manifest.json",
] as const;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as Json)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function exactSortedValues(values: Iterable<string>): string[] {
  return [...values].sort(compareStrings);
}

export async function writeCaseOutput(
  output: CaseOutput,
  outputPath = process.env.PDPP_PR89_CASE_OUTPUT_PATH
): Promise<void> {
  if (!outputPath) {
    return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${canonicalJson(output as unknown as Json)}\n`, "utf8");
}
