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
  readonly clientId: string | null | undefined;
  readonly baseUrl: string;
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
  initiate(
    clientId: string,
    opts: { baseUrl: string },
  ): Promise<AsDeviceAuthInitStoreResult> | AsDeviceAuthInitStoreResult;
}

export interface AsDeviceAuthInitSuccessOutcome {
  readonly outcome: "success";
  readonly status: 200;
  readonly traceContext: AsDeviceAuthInitTraceContext | null;
  readonly publicResult: Record<string, unknown>;
}

export interface AsDeviceAuthInitFailureOutcome {
  readonly outcome: "failure";
  readonly status: 400;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly requestId: string | null;
  readonly traceId: string | null;
}

export type AsDeviceAuthInitOutcome =
  | AsDeviceAuthInitSuccessOutcome
  | AsDeviceAuthInitFailureOutcome;

export async function executeAsDeviceAuthInit(
  input: AsDeviceAuthInitInput,
  deps: AsDeviceAuthInitDependencies,
): Promise<AsDeviceAuthInitOutcome> {
  if (!input.clientId) {
    return {
      outcome: "failure",
      status: 400,
      errorCode: "invalid_request",
      errorMessage: "client_id is required",
      requestId: null,
      traceId: null,
    };
  }
  try {
    const result = await deps.initiate(input.clientId, {
      baseUrl: input.baseUrl,
    });
    const traceContext = result.trace_context ?? null;
    const { trace_context: _ignored, ...publicResult } = result as Record<
      string,
      unknown
    >;
    return {
      outcome: "success",
      status: 200,
      traceContext,
      publicResult,
    };
  } catch (err) {
    const errCode = (err as { code?: string })?.code || "invalid_request";
    const errMessage =
      (err as { message?: string })?.message || "Device authorization rejected";
    return {
      outcome: "failure",
      status: 400,
      errorCode: errCode,
      errorMessage: errMessage,
      requestId: (err as { request_id?: string | null })?.request_id ?? null,
      traceId: (err as { trace_id?: string | null })?.trace_id ?? null,
    };
  }
}
