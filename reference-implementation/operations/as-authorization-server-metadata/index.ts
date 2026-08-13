// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  /** When true, advertise client_id_metadata_document in pdpp_registration_modes_supported. */
  readonly cimdEnabled?: boolean;
  readonly dynamicClientRegistrationEnabled: boolean;
  readonly issuer: string;
  readonly preRegisteredPublicClients?: readonly AsAuthorizationServerPublicClient[];
}

export interface AsAuthorizationServerPublicClient {
  readonly client_id: string;
  readonly client_name: string;
  readonly token_endpoint_auth_method: string;
}

export interface AsAuthorizationServerMetadataBuilderInput {
  readonly agentConnectEndpoint: string;
  readonly authorizationDetailsTypesSupported: readonly string[];
  readonly authorizationEndpoint: string;
  /** Passed through so buildAuthorizationServerMetadata can emit the standard draft field. */
  readonly cimdEnabled?: boolean;
  readonly codeChallengeMethodsSupported: readonly string[];
  readonly deviceAuthorizationEndpoint: string;
  readonly deviceAuthorizationProfilesSupported: readonly Record<string, unknown>[];
  readonly grantTypesSupported: readonly string[];
  readonly introspectionEndpoint: string;
  readonly issuer: string;
  readonly preRegisteredPublicClients: readonly AsAuthorizationServerPublicClient[];
  readonly providerConnectCapabilities: readonly string[];
  readonly pushedAuthorizationRequestEndpoint: string;
  readonly registrationEndpoint: string | null;
  readonly registrationModesSupported: readonly string[];
  readonly responseTypesSupported: readonly string[];
  readonly tokenEndpoint: string;
  readonly tokenEndpointAuthMethodsSupported: readonly string[];
}

export interface AsAuthorizationServerMetadataDependencies {
  buildAuthorizationServerMetadata: (input: AsAuthorizationServerMetadataBuilderInput) => unknown;
}

export function executeAsAuthorizationServerMetadata(
  input: AsAuthorizationServerMetadataInput,
  deps: AsAuthorizationServerMetadataDependencies
): unknown {
  const { issuer, dynamicClientRegistrationEnabled, preRegisteredPublicClients = [], cimdEnabled = false } = input;
  const registrationModesBase = dynamicClientRegistrationEnabled
    ? ["dynamic", "pre_registered_public"]
    : ["pre_registered_public"];
  const registrationModesSupported = cimdEnabled
    ? [...registrationModesBase, "client_id_metadata_document"]
    : registrationModesBase;
  return deps.buildAuthorizationServerMetadata({
    agentConnectEndpoint: `${issuer}/agent-connect`,
    authorizationDetailsTypesSupported: ["https://pdpp.dev/data-access"],
    authorizationEndpoint: `${issuer}/oauth/authorize`,
    cimdEnabled,
    codeChallengeMethodsSupported: ["S256"],
    deviceAuthorizationEndpoint: `${issuer}/oauth/device_authorization`,
    deviceAuthorizationProfilesSupported: [
      {
        authorization_details_type: "https://pdpp.dev/data-access",
        normal_mcp_setup: true,
        pdpp_token_kind: "client",
        profile: "grant_scoped_mcp",
        required_parameters: ["client_id", "resource", "authorization_details"],
      },
      {
        advertised_in: "pdpp_owner_agent_onboarding",
        mcp_owner_bearer_rejected: true,
        normal_mcp_setup: false,
        pdpp_token_kind: "owner",
        profile: "trusted_owner_agent",
      },
    ],
    grantTypesSupported: ["urn:ietf:params:oauth:grant-type:device_code", "authorization_code", "refresh_token"],
    introspectionEndpoint: `${issuer}/introspect`,
    issuer,
    preRegisteredPublicClients,
    providerConnectCapabilities: ["owner_self_export", "cli_device_connect", "third_party_client_connect"],
    pushedAuthorizationRequestEndpoint: `${issuer}/oauth/par`,
    registrationEndpoint: dynamicClientRegistrationEnabled ? `${issuer}/oauth/register` : null,
    registrationModesSupported,
    responseTypesSupported: ["code"],
    tokenEndpoint: `${issuer}/oauth/token`,
    tokenEndpointAuthMethodsSupported: ["none"],
  });
}
