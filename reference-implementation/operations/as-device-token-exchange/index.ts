// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

const SUPPORTED_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code" as const;

const CLIENT_FAULT_CODES = new Set([
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
  "invalid_grant",
  "invalid_client",
]);

export interface AsDeviceTokenExchangeInput {
  readonly clientId: string | null | undefined;
  readonly deviceCode: string | null | undefined;
  readonly grantType: string | null | undefined;
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
  exchangeDeviceCode: (args: {
    clientId: string | null | undefined;
    deviceCode: string | null | undefined;
  }) => Promise<AsDeviceTokenExchangeStoreResult> | AsDeviceTokenExchangeStoreResult;
}

export interface AsDeviceTokenExchangeSuccessOutcome {
  readonly outcome: "success";
  readonly publicResult: Record<string, unknown>;
  readonly status: 200;
  readonly traceContext: AsDeviceTokenExchangeTraceContext | null;
}

export interface AsDeviceTokenExchangeFailureOutcome {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly outcome: "failure";
  readonly requestId: string | null;
  readonly status: number;
  readonly traceId: string | null;
}

export type AsDeviceTokenExchangeOutcome = AsDeviceTokenExchangeSuccessOutcome | AsDeviceTokenExchangeFailureOutcome;

export async function executeAsDeviceTokenExchange(
  input: AsDeviceTokenExchangeInput,
  deps: AsDeviceTokenExchangeDependencies
): Promise<AsDeviceTokenExchangeOutcome> {
  if (input.grantType !== SUPPORTED_GRANT_TYPE) {
    return {
      errorCode: "unsupported_grant_type",
      errorMessage: "Only device_code grant_type is supported here",
      outcome: "failure",
      requestId: null,
      status: 400,
      traceId: null,
    };
  }

  try {
    const result = await deps.exchangeDeviceCode({
      clientId: input.clientId,
      deviceCode: input.deviceCode,
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
    const errCode = (err as { code?: string })?.code || "server_error";
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
    const errMessage = (err as { message?: string })?.message || "Token exchange failed";
    const status = CLIENT_FAULT_CODES.has(errCode) ? 400 : 500;
    return {
      errorCode: errCode,
      errorMessage: errMessage,
      outcome: "failure",
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      requestId: (err as { request_id?: string | null })?.request_id ?? null,
      status,
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Preserves established ordered async behavior, boundary contract, or dynamic test-harness type where a mechanical rewrite would change semantics.
      traceId: (err as { trace_id?: string | null })?.trace_id ?? null,
    };
  }
}
