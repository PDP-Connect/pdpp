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
  readonly requestUri: string | null | undefined;
  readonly approvalId: string | null | undefined;
  readonly subjectId: string;
  readonly approveOptions?: {
    readonly ai_training_consented?: unknown;
  };
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
  readonly token: string;
}

export interface AsConsentDecisionDependencies {
  getPendingConsentByApprovalId(
    approvalId: string,
  ):
    | Promise<AsConsentDecisionPendingRow | null>
    | AsConsentDecisionPendingRow
    | null;
  buildPendingConsentRequestUri(deviceCode: string): string;
  getPendingFromRequestUri(
    requestUri: string,
  ):
    | Promise<{
        deviceCode: string | null;
        pending: AsConsentDecisionPending | null;
      }>
    | {
        deviceCode: string | null;
        pending: AsConsentDecisionPending | null;
      };
  approveGrant(
    deviceCode: string,
    subjectId: string,
    opts: { ai_training_consented?: unknown } | undefined,
  ):
    | Promise<AsConsentDecisionApproveResult>
    | AsConsentDecisionApproveResult;
  denyGrant(deviceCode: string): Promise<boolean> | boolean;
}

export interface AsConsentDecisionApproveSuccessOutcome {
  readonly outcome: "success";
  readonly action: "approve";
  readonly traceContext: { request_id?: string | null; trace_id?: string | null } | null;
  readonly grant: { readonly grant_id: string; readonly [extra: string]: unknown };
  readonly token: string;
}

export interface AsConsentDecisionDenySuccessOutcome {
  readonly outcome: "success";
  readonly action: "deny";
  readonly traceContext: { request_id?: string | null; trace_id?: string | null } | null;
}

export interface AsConsentDecisionFailureOutcome {
  readonly outcome: "failure";
  readonly status: number;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export type AsConsentDecisionOutcome =
  | AsConsentDecisionApproveSuccessOutcome
  | AsConsentDecisionDenySuccessOutcome
  | AsConsentDecisionFailureOutcome;

export async function executeAsConsentDecision(
  input: AsConsentDecisionInput,
  deps: AsConsentDecisionDependencies,
): Promise<AsConsentDecisionOutcome> {
  let requestUri = input.requestUri || null;
  if (!requestUri && input.approvalId) {
    const row = await deps.getPendingConsentByApprovalId(input.approvalId);
    if (!row || row.status !== "pending") {
      return {
        outcome: "failure",
        status: 404,
        errorCode: "not_found",
        errorMessage: "No pending consent for approval_id",
      };
    }
    requestUri = deps.buildPendingConsentRequestUri(row.device_code);
  }

  if (!requestUri) {
    return {
      outcome: "failure",
      status: 400,
      errorCode: "invalid_request",
      errorMessage: "request_uri or approval_id is required",
    };
  }

  const { deviceCode, pending } = await deps.getPendingFromRequestUri(
    requestUri,
  );
  if (!deviceCode) {
    return {
      outcome: "failure",
      status: 400,
      errorCode: "invalid_request",
      errorMessage: "request_uri or approval_id is required",
    };
  }

  const traceContext = pending?.request?.trace_context ?? null;

  if (input.action === "approve") {
    const approve = await deps.approveGrant(
      deviceCode,
      input.subjectId,
      input.approveOptions,
    );
    return {
      outcome: "success",
      action: "approve",
      traceContext,
      grant: approve.grant,
      token: approve.token,
    };
  }

  const deleted = await deps.denyGrant(deviceCode);
  if (!deleted) {
    return {
      outcome: "failure",
      status: 404,
      errorCode: "not_found",
      errorMessage: "Pending consent request not found",
    };
  }
  return {
    outcome: "success",
    action: "deny",
    traceContext,
  };
}
