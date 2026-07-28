// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `as.device.authorization.init` operation.
 *
 * Owns the device-authorization initiation envelope semantics for
 * `POST /oauth/device_authorization`: client-id presence validation, the
 * call into the owner-device-auth store, and the
 * `trace_context`-stripped public response shape.
 *
 * The host adapter owns Express plumbing, public-URL resolution, header
 * propagation (`Request-Id`, reference trace id), and concrete capability
 * wiring (`ownerDeviceAuthStore.initiate`).
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export interface AsDeviceAuthInitInput {
  readonly baseUrl: string;
  readonly clientId: string | null | undefined;
}

export interface AsDeviceAuthInitTraceContext {
  readonly request_id?: string | null;
  readonly trace_id?: string | null;
}

export interface AsDeviceAuthInitStoreResult {
  readonly trace_context?: AsDeviceAuthInitTraceContext | null;
  readonly [extra: string]: unknown;
}

export interface AsDeviceAuthInitDependencies {
  initiate: (
    clientId: string,
    opts: { baseUrl: string }
  ) => Promise<AsDeviceAuthInitStoreResult> | AsDeviceAuthInitStoreResult;
}

export interface AsDeviceAuthInitSuccessOutcome {
  readonly outcome: "success";
  readonly publicResult: Record<string, unknown>;
  readonly status: 200;
  readonly traceContext: AsDeviceAuthInitTraceContext | null;
}

export interface AsDeviceAuthInitFailureOutcome {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly outcome: "failure";
  readonly requestId: string | null;
  readonly status: 400;
  readonly traceId: string | null;
}

export type AsDeviceAuthInitOutcome = AsDeviceAuthInitSuccessOutcome | AsDeviceAuthInitFailureOutcome;

export async function executeAsDeviceAuthInit(
  input: AsDeviceAuthInitInput,
  deps: AsDeviceAuthInitDependencies
): Promise<AsDeviceAuthInitOutcome> {
  if (!input.clientId) {
    return {
      errorCode: "invalid_request",
      errorMessage: "client_id is required",
      outcome: "failure",
      requestId: null,
      status: 400,
      traceId: null,
    };
  }
  try {
    const result = await deps.initiate(input.clientId, {
      baseUrl: input.baseUrl,
    });
    const traceContext = result.trace_context ?? null;
    const { trace_context: _ignored, ...publicResult } = result as Record<string, unknown>;
    return {
      outcome: "success",
      publicResult,
      status: 200,
      traceContext,
    };
  } catch (err) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const errCode = (err as { code?: string })?.code || "invalid_request";
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const errMessage = (err as { message?: string })?.message || "Device authorization rejected";
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
