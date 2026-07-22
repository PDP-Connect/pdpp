// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `as.dcr.register` operation.
 *
 * Owns the dynamic-client-registration semantics for `POST /oauth/register`:
 * input sanitization (strip route-owned `issuer_subject_id` from request
 * body), extra-metadata derivation from the optional owner session,
 * success/failure spine-event data shapes, and HTTP status-code mapping.
 *
 * The host adapter owns Express plumbing, owner-session resolution,
 * trace-context emission, response writing, and concrete capability wiring
 * (`registerDynamicClient`, `emitSpineEvent`).
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export type DcrRegisterErrorCode =
  | "invalid_client"
  | "invalid_request"
  | "invalid_client_metadata";

export interface DcrRegisterInput {
  /** Free-form request body (typed by JSON parser). */
  readonly body: Record<string, unknown> | null | undefined;
  /** Authorization header value, if present. */
  readonly authorizationHeader: string | null;
  /** Whether DCR is enabled in this AS deployment. */
  readonly dcrEnabled: boolean;
  /**
   * Initial-access tokens accepted by this AS. The operation does the
   * literal-equality check; the host owns the configuration source.
   */
  readonly initialAccessTokens: readonly string[];
  /** Owner session subject id, or null if anonymous. */
  readonly ownerSessionSubjectId: string | null;
}

export interface DcrRegisteredClient {
  readonly client_id: string;
  readonly client_name?: string | null;
  readonly token_endpoint_auth_method?: string | null;
  readonly redirect_uris?: readonly string[] | null;
  readonly [extra: string]: unknown;
}

export interface DcrRegisterDependencies {
  /** Persist a new dynamic client registration. */
  registerDynamicClient(
    sanitizedInput: Record<string, unknown>,
    extraMetadata: Record<string, unknown>,
  ): Promise<DcrRegisteredClient> | DcrRegisteredClient;
}

export interface DcrRegisterRequestSummary {
  readonly requested_client_name: string | null;
  readonly requested_token_endpoint_auth_method: string | null;
  readonly requested_redirect_uri_count: number;
  readonly requested_metadata_fields: readonly string[];
}

export interface DcrRegisterError extends Error {
  code: DcrRegisterErrorCode;
}

export interface DcrRegisterSuccessSpineData {
  readonly registration_mode: "dynamic";
  readonly registration_access:
    | "public"
    | "initial_access_token"
    | "owner_session";
  readonly client_name: string | null;
  readonly token_endpoint_auth_method: string | null;
  readonly redirect_uri_count: number;
}

export interface DcrRegisterFailureSpineData extends DcrRegisterRequestSummary {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface DcrRegisterSuccessOutcome {
  readonly outcome: "success";
  readonly status: 201;
  readonly registered: DcrRegisteredClient;
  readonly spineData: DcrRegisterSuccessSpineData;
}

export interface DcrRegisterFailureOutcome {
  readonly outcome: "failure";
  readonly status: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly spineData: DcrRegisterFailureSpineData;
}

export type DcrRegisterOutcome =
  | DcrRegisterSuccessOutcome
  | DcrRegisterFailureOutcome;

export function summarizeDcrRegisterRequest(
  body: Record<string, unknown> | null | undefined,
): DcrRegisterRequestSummary {
  const safe =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  return {
    requested_client_name:
      typeof safe.client_name === "string" ? safe.client_name : null,
    requested_token_endpoint_auth_method:
      typeof safe.token_endpoint_auth_method === "string"
        ? safe.token_endpoint_auth_method
        : null,
    requested_redirect_uri_count: Array.isArray(safe.redirect_uris)
      ? safe.redirect_uris.length
      : 0,
    requested_metadata_fields: Object.keys(safe).sort(),
  };
}

function mapErrorStatus(code: string): number {
  if (code === "invalid_client") return 401;
  if (code === "invalid_request") return 404;
  return 400;
}

export async function executeAsDcrRegister(
  input: DcrRegisterInput,
  deps: DcrRegisterDependencies,
): Promise<DcrRegisterOutcome> {
  const requestSummary = summarizeDcrRegisterRequest(input.body);
  try {
    if (!input.dcrEnabled) {
      const err = new Error(
        "Dynamic client registration is not enabled",
      ) as DcrRegisterError;
      err.code = "invalid_request";
      throw err;
    }

    const auth = input.authorizationHeader;
    let registrationAccess: DcrRegisterSuccessSpineData["registration_access"] =
      input.ownerSessionSubjectId ? "owner_session" : "public";
    if (auth) {
      if (!auth.startsWith("Bearer ")) {
        const err = new Error("Malformed initial access token") as DcrRegisterError;
        err.code = "invalid_client";
        throw err;
      }
      const initialAccessToken = auth.slice(7);
      if (!input.initialAccessTokens.includes(initialAccessToken)) {
        const err = new Error("Invalid initial access token") as DcrRegisterError;
        err.code = "invalid_client";
        throw err;
      }
      registrationAccess = "initial_access_token";
    }

    // `issuer_subject_id` is a reference-only stamp owned by this operation
    // layer. Anonymous DCR callers cannot tag themselves to an owner;
    // owner-authed callers get the session subject, not the body value.
    const sanitizedInput: Record<string, unknown> =
      input.body && typeof input.body === "object" && !Array.isArray(input.body)
        ? { ...(input.body as Record<string, unknown>) }
        : {};
    delete sanitizedInput.issuer_subject_id;

    const extraMetadata: Record<string, unknown> = input.ownerSessionSubjectId
      ? { issuer_subject_id: input.ownerSessionSubjectId }
      : {};

    const registered = await deps.registerDynamicClient(
      sanitizedInput,
      extraMetadata,
    );

    return {
      outcome: "success",
      status: 201,
      registered,
      spineData: {
        registration_mode: "dynamic",
        registration_access: registrationAccess,
        client_name: registered.client_name || null,
        token_endpoint_auth_method:
          registered.token_endpoint_auth_method || null,
        redirect_uri_count: Array.isArray(registered.redirect_uris)
          ? registered.redirect_uris.length
          : 0,
      },
    };
  } catch (err) {
    const errCode =
      (err as { code?: string })?.code || "invalid_client_metadata";
    const errMessage =
      (err as { message?: string })?.message || "Registration rejected";
    return {
      outcome: "failure",
      status: mapErrorStatus(errCode),
      errorCode: errCode,
      errorMessage: errMessage,
      spineData: {
        ...requestSummary,
        error: {
          code: errCode,
          message: errMessage,
        },
      },
    };
  }
}
