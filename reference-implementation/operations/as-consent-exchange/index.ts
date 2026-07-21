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
}

export type AsConsentExchangeConsumeResult =
  | {
      readonly ok: true;
      readonly grantId: string;
      readonly token: string;
      readonly grant: Record<string, unknown>;
    }
  | { readonly ok: false; readonly reason: "expired" | "consumed" | string };

export interface AsConsentExchangeDependencies {
  consumeConsentExchangeCode(
    code: string,
  ): Promise<AsConsentExchangeConsumeResult> | AsConsentExchangeConsumeResult;
}

export interface AsConsentExchangeSuccessOutcome {
  readonly outcome: "success";
  readonly envelope: {
    readonly grant_id: string;
    readonly token: string;
    readonly grant: Record<string, unknown>;
  };
}

export interface AsConsentExchangeFailureOutcome {
  readonly outcome: "failure";
  readonly status: number;
  readonly errorCode: string;
  readonly errorMessage: string;
}

export type AsConsentExchangeOutcome =
  | AsConsentExchangeSuccessOutcome
  | AsConsentExchangeFailureOutcome;

export async function executeAsConsentExchange(
  input: AsConsentExchangeInput,
  deps: AsConsentExchangeDependencies,
): Promise<AsConsentExchangeOutcome> {
  if (typeof input.code !== "string" || !input.code) {
    return {
      outcome: "failure",
      status: 400,
      errorCode: "invalid_request",
      errorMessage: "code is required",
    };
  }
  const result = await deps.consumeConsentExchangeCode(input.code);
  if (!result.ok) {
    if (result.reason === "expired") {
      return {
        outcome: "failure",
        status: 410,
        errorCode: "invalid_grant",
        errorMessage: "Consent exchange code has expired",
      };
    }
    if (result.reason === "consumed") {
      return {
        outcome: "failure",
        status: 410,
        errorCode: "invalid_grant",
        errorMessage: "Consent exchange code has already been redeemed",
      };
    }
    return {
      outcome: "failure",
      status: 404,
      errorCode: "not_found",
      errorMessage: "Unknown consent exchange code",
    };
  }
  return {
    outcome: "success",
    envelope: {
      grant_id: result.grantId,
      token: result.token,
      grant: result.grant,
    },
  };
}
