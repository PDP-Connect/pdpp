// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `as.polyfill.connector.register` operation.
 *
 * Owns the polyfill-only connector-registration semantics for `POST
 * /connectors`: manifest presence + connector identity validation, the
 * call into `registerConnector`, and the success-envelope shape.
 *
 * The host adapter owns Express plumbing, native-mode toggle (route is
 * only mounted when polyfill mode is active), and response writing.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export interface AsPolyfillConnectorRegisterInput {
  readonly manifest: Record<string, unknown> | null | undefined;
}

export interface AsPolyfillConnectorRegisterDependencies {
  registerConnector(manifest: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface AsPolyfillConnectorRegisterSuccessOutcome {
  readonly outcome: "success";
  readonly status: 201;
  readonly envelope: { readonly connector_id: string; readonly connector_key: string };
}

export interface AsPolyfillConnectorRegisterFailureOutcome {
  readonly outcome: "failure";
  readonly status: 400;
  readonly errorCode: "invalid_request";
  readonly errorMessage: string;
}

export type AsPolyfillConnectorRegisterOutcome =
  | AsPolyfillConnectorRegisterSuccessOutcome
  | AsPolyfillConnectorRegisterFailureOutcome;

export async function executeAsPolyfillConnectorRegister(
  input: AsPolyfillConnectorRegisterInput,
  deps: AsPolyfillConnectorRegisterDependencies,
): Promise<AsPolyfillConnectorRegisterOutcome> {
  const manifest = input.manifest;
  const connectorKey =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? ((manifest as Record<string, unknown>).connector_key
        ?? (manifest as Record<string, unknown>).connector_id)
      : undefined;
  if (typeof connectorKey !== "string" || !connectorKey) {
    return {
      outcome: "failure",
      status: 400,
      errorCode: "invalid_request",
      errorMessage: "Missing connector_key or connector_id",
    };
  }
  const registered = await deps.registerConnector(manifest as Record<string, unknown>);
  const registeredKey = typeof registered === "string" && registered ? registered : connectorKey;
  return {
    outcome: "success",
    status: 201,
    envelope: { connector_id: registeredKey, connector_key: registeredKey },
  };
}
