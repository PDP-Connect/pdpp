// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `as.device.decision` operation.
 *
 * Owns the device-authorization approve/deny decision semantics shared by
 * `POST /device/approve` and `POST /device/deny`: resolution of the
 * caller-supplied `approval_id` to a pending `user_code`, presence
 * validation, the call into the owner-device-auth store, and HTTP error
 * mapping. The host adapter owns Express plumbing, owner-session + CSRF
 * enforcement, subject-id resolution, and HTML rendering of the result
 * page.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export type AsDeviceDecisionAction = "approve" | "deny";

export interface AsDeviceDecisionInput {
  readonly action: AsDeviceDecisionAction;
  readonly approvalId: string | null | undefined;
  readonly subjectId: string;
  readonly userCode: string | null | undefined;
}

export interface AsDeviceDecisionPendingRow {
  readonly status: string;
  readonly user_code: string;
  readonly [extra: string]: unknown;
}

export interface AsDeviceDecisionDependencies {
  approve: (userCode: string, subjectId: string) => Promise<unknown> | unknown;
  deny: (userCode: string, subjectId: string) => Promise<unknown> | unknown;
  getByApprovalId: (
    approvalId: string
  ) => Promise<AsDeviceDecisionPendingRow | null> | AsDeviceDecisionPendingRow | null;
}

export interface AsDeviceDecisionSuccessOutcome {
  readonly outcome: "success";
  readonly userCode: string;
}

export interface AsDeviceDecisionFailureOutcome {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly outcome: "failure";
  readonly requestId: string | null;
  readonly status: number;
  readonly traceId: string | null;
}

export type AsDeviceDecisionOutcome = AsDeviceDecisionSuccessOutcome | AsDeviceDecisionFailureOutcome;

export async function executeAsDeviceDecision(
  input: AsDeviceDecisionInput,
  deps: AsDeviceDecisionDependencies
): Promise<AsDeviceDecisionOutcome> {
  let userCode = input.userCode || null;
  if (!userCode && input.approvalId) {
    const row = await deps.getByApprovalId(input.approvalId);
    if (row?.status !== "pending") {
      return {
        errorCode: "not_found",
        errorMessage: "No pending device authorization for approval_id",
        outcome: "failure",
        requestId: null,
        status: 404,
        traceId: null,
      };
    }
    userCode = row.user_code;
  }
  if (!userCode) {
    return {
      errorCode: "invalid_request",
      errorMessage: "user_code or approval_id is required",
      outcome: "failure",
      requestId: null,
      status: 400,
      traceId: null,
    };
  }

  try {
    if (input.action === "approve") {
      await deps.approve(userCode, input.subjectId);
    } else {
      await deps.deny(userCode, input.subjectId);
    }
    return { outcome: "success", userCode };
  } catch (err) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const errCode = (err as { code?: string })?.code || "invalid_request";
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const errMessage = (err as { message?: string })?.message || "Device decision rejected";
    return {
      errorCode: errCode,
      errorMessage: errMessage,
      outcome: "failure",
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      requestId: (err as { request_id?: string | null })?.request_id ?? null,
      status: 400,
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      traceId: (err as { trace_id?: string | null })?.trace_id ?? null,
    };
  }
}
