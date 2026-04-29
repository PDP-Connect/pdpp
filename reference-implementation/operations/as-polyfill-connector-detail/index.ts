/**
 * Canonical `as.polyfill.connector.detail` operation.
 *
 * Owns the polyfill-only connector-detail semantics for `GET
 * /connectors/:connectorId`: manifest lookup via dependency, presence
 * mapping (missing manifest → 404), and the manifest-as-envelope contract.
 *
 * The host adapter owns Express plumbing, URL decoding of the path
 * parameter, native-mode mounting, and response writing.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 */

export interface AsPolyfillConnectorDetailInput {
  readonly connectorId: string;
}

export interface AsPolyfillConnectorDetailDependencies {
  getConnectorManifest(
    connectorId: string,
  ): Promise<Record<string, unknown> | null | undefined> | Record<string, unknown> | null | undefined;
}

export interface AsPolyfillConnectorDetailSuccessOutcome {
  readonly outcome: "success";
  readonly envelope: Record<string, unknown>;
}

export interface AsPolyfillConnectorDetailFailureOutcome {
  readonly outcome: "failure";
  readonly status: 404;
  readonly errorCode: "not_found";
  readonly errorMessage: string;
}

export type AsPolyfillConnectorDetailOutcome =
  | AsPolyfillConnectorDetailSuccessOutcome
  | AsPolyfillConnectorDetailFailureOutcome;

export async function executeAsPolyfillConnectorDetail(
  input: AsPolyfillConnectorDetailInput,
  deps: AsPolyfillConnectorDetailDependencies,
): Promise<AsPolyfillConnectorDetailOutcome> {
  const manifest = await deps.getConnectorManifest(input.connectorId);
  if (!manifest) {
    return {
      outcome: "failure",
      status: 404,
      errorCode: "not_found",
      errorMessage: "Connector not found",
    };
  }
  return { outcome: "success", envelope: manifest };
}
