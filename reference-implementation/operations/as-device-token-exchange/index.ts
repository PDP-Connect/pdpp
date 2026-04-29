/**
 * Canonical `as.device.token.exchange` operation.
 *
 * Owns the OAuth device-code token-exchange semantics for `POST
 * /oauth/token`: grant-type allowlist, the call into the owner-device-auth
 * store, error-status mapping (RFC 8628 client-fault codes → 400, others →
 * 500), and the `trace_context`-stripped public response shape.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

const SUPPORTED_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code" as const;

const CLIENT_FAULT_CODES = new Set([
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
  "invalid_grant",
  "invalid_client",
]);

export interface AsDeviceTokenExchangeInput {
  readonly grantType: string | null | undefined;
  readonly clientId: string | null | undefined;
  readonly deviceCode: string | null | undefined;
}

export interface AsDeviceTokenExchangeTraceContext {
  readonly request_id?: string | null;
  readonly trace_id?: string | null;
}

export interface AsDeviceTokenExchangeStoreResult {
  readonly trace_context?: AsDeviceTokenExchangeTraceContext | null;
  readonly [extra: string]: unknown;
}

export interface AsDeviceTokenExchangeDependencies {
  exchangeDeviceCode(args: {
    clientId: string | null | undefined;
    deviceCode: string | null | undefined;
  }):
    | Promise<AsDeviceTokenExchangeStoreResult>
    | AsDeviceTokenExchangeStoreResult;
}

export interface AsDeviceTokenExchangeSuccessOutcome {
  readonly outcome: "success";
  readonly status: 200;
  readonly traceContext: AsDeviceTokenExchangeTraceContext | null;
  readonly publicResult: Record<string, unknown>;
}

export interface AsDeviceTokenExchangeFailureOutcome {
  readonly outcome: "failure";
  readonly status: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly requestId: string | null;
  readonly traceId: string | null;
}

export type AsDeviceTokenExchangeOutcome =
  | AsDeviceTokenExchangeSuccessOutcome
  | AsDeviceTokenExchangeFailureOutcome;

export async function executeAsDeviceTokenExchange(
  input: AsDeviceTokenExchangeInput,
  deps: AsDeviceTokenExchangeDependencies,
): Promise<AsDeviceTokenExchangeOutcome> {
  if (input.grantType !== SUPPORTED_GRANT_TYPE) {
    return {
      outcome: "failure",
      status: 400,
      errorCode: "unsupported_grant_type",
      errorMessage:
        "Only device_code grant_type is supported here",
      requestId: null,
      traceId: null,
    };
  }

  try {
    const result = await deps.exchangeDeviceCode({
      clientId: input.clientId,
      deviceCode: input.deviceCode,
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
    const errCode = (err as { code?: string })?.code || "server_error";
    const errMessage =
      (err as { message?: string })?.message || "Token exchange failed";
    const status = CLIENT_FAULT_CODES.has(errCode) ? 400 : 500;
    return {
      outcome: "failure",
      status,
      errorCode: errCode,
      errorMessage: errMessage,
      requestId: (err as { request_id?: string | null })?.request_id ?? null,
      traceId: (err as { trace_id?: string | null })?.trace_id ?? null,
    };
  }
}
