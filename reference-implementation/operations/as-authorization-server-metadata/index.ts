/**
 * Canonical `as.authorization_server.metadata` operation.
 *
 * Owns the RFC 8414-shaped authorization-server metadata envelope returned
 * at `GET /.well-known/oauth-authorization-server`. The host adapter
 * resolves the public issuer URL, dynamic-client-registration toggle, and
 * other deployment-shaped inputs; the operation projects them into the
 * canonical AS metadata document via the existing
 * `buildAuthorizationServerMetadata` capability.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres,
 *   raw SQL handles, server-internal route/auth modules, sandbox modules, or
 *   `process` / `process.env`.
 * - Metadata-document assembly flows in through a dependency. The host
 *   wires the concrete builder from `server/metadata.ts`.
 */

export interface AsAuthorizationServerMetadataInput {
  readonly issuer: string;
  readonly dynamicClientRegistrationEnabled: boolean;
}

export interface AsAuthorizationServerMetadataBuilderInput {
  readonly issuer: string;
  readonly introspectionEndpoint: string;
  readonly pushedAuthorizationRequestEndpoint: string;
  readonly registrationEndpoint: string | null;
  readonly providerConnectCapabilities: readonly string[];
  readonly registrationModesSupported: readonly string[];
  readonly authorizationDetailsTypesSupported: readonly string[];
  readonly tokenEndpoint: string;
  readonly tokenEndpointAuthMethodsSupported: readonly string[];
  readonly deviceAuthorizationEndpoint: string;
  readonly agentConnectEndpoint: string;
  readonly grantTypesSupported: readonly string[];
}

export interface AsAuthorizationServerMetadataDependencies {
  buildAuthorizationServerMetadata(
    input: AsAuthorizationServerMetadataBuilderInput,
  ): unknown;
}

export function executeAsAuthorizationServerMetadata(
  input: AsAuthorizationServerMetadataInput,
  deps: AsAuthorizationServerMetadataDependencies,
): unknown {
  const { issuer, dynamicClientRegistrationEnabled } = input;
  const registrationModesSupported = dynamicClientRegistrationEnabled
    ? (["dynamic", "pre_registered_public"] as const)
    : (["pre_registered_public"] as const);
  return deps.buildAuthorizationServerMetadata({
    issuer,
    introspectionEndpoint: `${issuer}/introspect`,
    pushedAuthorizationRequestEndpoint: `${issuer}/oauth/par`,
    registrationEndpoint: dynamicClientRegistrationEnabled
      ? `${issuer}/oauth/register`
      : null,
    providerConnectCapabilities: [
      "owner_self_export",
      "cli_device_connect",
      "third_party_client_connect",
    ],
    registrationModesSupported,
    authorizationDetailsTypesSupported: ["https://pdpp.org/data-access"],
    tokenEndpoint: `${issuer}/oauth/token`,
    tokenEndpointAuthMethodsSupported: ["none"],
    deviceAuthorizationEndpoint: `${issuer}/oauth/device_authorization`,
    agentConnectEndpoint: `${issuer}/agent-connect`,
    grantTypesSupported: ["urn:ietf:params:oauth:grant-type:device_code"],
  });
}
