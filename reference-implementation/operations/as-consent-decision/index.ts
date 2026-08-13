// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `as.consent.decision` operation.
 *
 * Owns the consent approve/deny decision semantics shared by `POST
 * /consent/approve` and `POST /consent/deny`: resolution of the optional
 * `approval_id` to a canonical `request_uri` (so the live device_code
 * never leaves the AS through a public read surface), `request_uri`
 * presence enforcement, the call into the consent-store
 * approve/deny capability, and HTTP error mapping.
 *
 * The host adapter owns Express plumbing, owner-session + CSRF
 * enforcement, subject-id resolution, content-negotiation between the
 * JSON and HTML response branches, exchange-code minting, and HTML
 * rendering.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export type AsConsentDecisionAction = "approve" | "deny";

export interface AsConsentDecisionInput {
  readonly action: AsConsentDecisionAction;
  readonly approvalId: string | null | undefined;
  readonly approveOptions?: {
    readonly approval_review_revision?: unknown;
    readonly approvedSourceIndexes?: readonly number[];
    readonly confirmedApproveAll?: boolean;
    readonly sourceNarrowing?: Readonly<Record<number, unknown>>;
  };
  readonly requestUri: string | null | undefined;
  readonly subjectId?: string;
}

export interface AsConsentDecisionPendingRow {
  readonly device_code: string;
  readonly status: string;
  readonly [extra: string]: unknown;
}

export interface AsConsentDecisionPending {
  readonly request?: {
    readonly trace_context?: {
      readonly request_id?: string | null;
      readonly trace_id?: string | null;
    } | null;
    readonly [extra: string]: unknown;
  };
  readonly [extra: string]: unknown;
}

export interface AsConsentDecisionApproveResult {
  readonly grant: { readonly grant_id: string; readonly [extra: string]: unknown };
  readonly package?: boolean;
  readonly package_id?: string;
  readonly token: string;
}

export interface AsConsentDecisionDependencies {
  approveGrant: (
    deviceCode: string,
    subjectId: string | undefined,
    opts:
      | {
          approval_review_revision?: unknown;
          approvedSourceIndexes?: readonly number[];
          baseUrl?: string | null;
          confirmedApproveAll?: boolean;
          sourceNarrowing?: Readonly<Record<number, unknown>>;
        }
      | undefined
  ) => Promise<AsConsentDecisionApproveResult> | AsConsentDecisionApproveResult;
  buildPendingConsentRequestUri: (deviceCode: string) => string;
  denyGrant: (deviceCode: string) => Promise<boolean> | boolean;
  getPendingConsentByApprovalId: (
    approvalId: string
  ) => Promise<AsConsentDecisionPendingRow | null> | AsConsentDecisionPendingRow | null;
  getPendingFromRequestUri: (requestUri: string) =>
    | Promise<{
        deviceCode: string | null;
        pending: AsConsentDecisionPending | null;
      }>
    | {
        deviceCode: string | null;
        pending: AsConsentDecisionPending | null;
      };
}

export interface AsConsentDecisionApproveSuccessOutcome {
  readonly action: "approve";
  readonly grant: { readonly grant_id: string; readonly [extra: string]: unknown };
  readonly outcome: "success";
  readonly package?: boolean;
  readonly package_id?: string;
  readonly token: string;
  readonly traceContext: { request_id?: string | null; trace_id?: string | null } | null;
}

export interface AsConsentDecisionDenySuccessOutcome {
  readonly action: "deny";
  readonly outcome: "success";
  /** Canonical request URI, including when the caller supplied approval_id. */
  readonly requestUri: string;
  readonly traceContext: { request_id?: string | null; trace_id?: string | null } | null;
}

export interface AsConsentDecisionFailureOutcome {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly outcome: "failure";
  readonly status: number;
}

export type AsConsentDecisionOutcome =
  | AsConsentDecisionApproveSuccessOutcome
  | AsConsentDecisionDenySuccessOutcome
  | AsConsentDecisionFailureOutcome;

export async function executeAsConsentDecision(
  input: AsConsentDecisionInput,
  deps: AsConsentDecisionDependencies
): Promise<AsConsentDecisionOutcome> {
  let requestUri = input.requestUri || null;
  if (!requestUri && input.approvalId) {
    const row = await deps.getPendingConsentByApprovalId(input.approvalId);
    if (!(row && (row.status === "pending" || (input.action === "approve" && row.status === "approved")))) {
      return {
        errorCode: "not_found",
        errorMessage: "No pending consent for approval_id",
        outcome: "failure",
        status: 404,
      };
    }
    requestUri = deps.buildPendingConsentRequestUri(row.device_code);
  }

  if (!requestUri) {
    return {
      errorCode: "invalid_request",
      errorMessage: "request_uri or approval_id is required",
      outcome: "failure",
      status: 400,
    };
  }

  const { deviceCode, pending } = await deps.getPendingFromRequestUri(requestUri);
  if (!deviceCode) {
    return {
      errorCode: "invalid_request",
      errorMessage: "request_uri or approval_id is required",
      outcome: "failure",
      status: 400,
    };
  }

  const traceContext = pending?.request?.trace_context ?? null;

  if (input.action === "approve") {
    const approve = await deps.approveGrant(deviceCode, undefined, input.approveOptions);
    return {
      action: "approve",
      grant: approve.grant,
      outcome: "success",
      token: approve.token,
      traceContext,
      ...(approve.package ? { package: true, package_id: approve.package_id } : {}),
    };
  }

  const deleted = await deps.denyGrant(deviceCode);
  if (!deleted) {
    return {
      errorCode: "not_found",
      errorMessage: "Pending consent request not found",
      outcome: "failure",
      status: 404,
    };
  }
  return {
    action: "deny",
    outcome: "success",
    requestUri,
    traceContext,
  };
}
