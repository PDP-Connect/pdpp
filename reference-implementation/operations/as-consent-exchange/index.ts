// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `as.consent.exchange` operation.
 *
 * Owns the consent-exchange-code redemption semantics for `POST
 * /consent/exchange`: presence validation, the call into
 * `consumeConsentExchangeCode`, and HTTP error mapping for the typed
 * failure reasons (`expired` → 410 invalid_grant, `consumed` → 410
 * invalid_grant, unknown code → 404 not_found).
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export interface AsConsentExchangeInput {
  readonly code: string | null | undefined;
  readonly proof?: string | null | undefined;
}

export type AsConsentExchangeConsumeResult =
  | {
      readonly ok: true;
      readonly grantId?: string;
      readonly packageId?: string;
      readonly token: string;
      readonly grant: Record<string, unknown>;
    }
  | { readonly ok: false; readonly reason: "expired" | "consumed" | string };

export interface AsConsentExchangeDependencies {
  consumeConsentExchangeCode: (
    code: string,
    proof?: string | null | undefined
  ) => Promise<AsConsentExchangeConsumeResult> | AsConsentExchangeConsumeResult;
}

export interface AsConsentExchangeSuccessOutcome {
  readonly envelope: {
    readonly grant_id?: string;
    readonly package_id?: string;
    readonly token: string;
    readonly grant: Record<string, unknown>;
  };
  readonly outcome: "success";
}

export interface AsConsentExchangeFailureOutcome {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly outcome: "failure";
  readonly status: number;
}

export type AsConsentExchangeOutcome = AsConsentExchangeSuccessOutcome | AsConsentExchangeFailureOutcome;

export async function executeAsConsentExchange(
  input: AsConsentExchangeInput,
  deps: AsConsentExchangeDependencies
): Promise<AsConsentExchangeOutcome> {
  if (typeof input.code !== "string" || !input.code) {
    return {
      errorCode: "invalid_request",
      errorMessage: "code is required",
      outcome: "failure",
      status: 400,
    };
  }
  const result = await deps.consumeConsentExchangeCode(input.code, input.proof);
  if (!result.ok) {
    if (result.reason === "expired") {
      return {
        errorCode: "invalid_grant",
        errorMessage: "Consent exchange code has expired",
        outcome: "failure",
        status: 410,
      };
    }
    if (result.reason === "consumed") {
      return {
        errorCode: "invalid_grant",
        errorMessage: "Consent exchange code has already been redeemed",
        outcome: "failure",
        status: 410,
      };
    }
    return {
      errorCode: "not_found",
      errorMessage: "Unknown consent exchange code",
      outcome: "failure",
      status: 404,
    };
  }
  let resultIdentity: { package_id: string } | { grant_id: string } | Record<string, never> = {};
  if (result.packageId) {
    resultIdentity = { package_id: result.packageId };
  } else if (result.grantId) {
    resultIdentity = { grant_id: result.grantId };
  }
  return {
    envelope: {
      grant: result.grant,
      token: result.token,
      ...resultIdentity,
    },
    outcome: "success",
  };
}
