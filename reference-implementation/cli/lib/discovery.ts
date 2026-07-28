// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CliFlags } from "./args.ts";
import { resolveRsUrl } from "./common.ts";
import { PdppCliError } from "./errors.ts";
import { fetchJson } from "./fetch.ts";

// The RFC 9728 OAuth protected-resource metadata document, extended with
// the PDPP-specific advertisement fields the reference server adds. This is
// parsed from an untrusted HTTP response body, so every field is optional;
// callers narrow before use (see provider.ts's `'field' in metadata` guards).
export interface ProtectedResourceMetadata {
  authorization_servers?: string[];
  pdpp_core_query_base?: string;
  pdpp_provider_connect_version?: string;
  pdpp_self_export_supported?: boolean;
  pdpp_token_kinds_supported?: string[];
  resource?: string;
  resource_name?: string;
}

// The RFC 8414 OAuth authorization-server metadata document, likewise
// extended with PDPP-specific fields and likewise all-optional as parsed
// network input.
export interface AuthorizationServerMetadata {
  authorization_endpoint?: string;
  client_id_metadata_document_supported?: boolean;
  code_challenge_methods_supported?: string[];
  device_authorization_endpoint?: string;
  grant_types_supported?: string[];
  introspection_endpoint?: string;
  issuer?: string;
  pdpp_authorization_details_types_supported?: string[];
  pdpp_provider_connect_capabilities?: string[];
  pdpp_registration_modes_supported?: string[];
  pushed_authorization_request_endpoint?: string;
  registration_endpoint?: string;
  response_types_supported?: string[];
  token_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

export interface DiscoveredProvider {
  advertisedAuthorizationServers: string[];
  authorizationServer: string;
  authorizationServerAdvertised: boolean;
  authorizationServerMetadata: AuthorizationServerMetadata;
  resourceMetadata: ProtectedResourceMetadata;
  rsUrl: string;
}

export async function discoverProvider(flags: CliFlags): Promise<DiscoveredProvider> {
  const rsUrl = normalizeUrl(resolveRsUrl(flags));
  const expectedAsUrl = flags["as-url"] ? normalizeUrl(flags["as-url"]) : null;
  const { body: resourceMetadataBody } = await fetchJson(`${rsUrl}/.well-known/oauth-protected-resource`);
  const resourceMetadata = (resourceMetadataBody ?? {}) as ProtectedResourceMetadata;
  const advertisedAuthorizationServers = (resourceMetadata.authorization_servers || []).map(normalizeUrl);

  if (resourceMetadata.resource && normalizeUrl(resourceMetadata.resource) !== rsUrl) {
    throw new PdppCliError(
      `Protected-resource metadata resource mismatch: expected ${rsUrl}, got ${resourceMetadata.resource}`
    );
  }

  const authorizationServer = expectedAsUrl || advertisedAuthorizationServers[0];
  if (!authorizationServer) {
    throw new PdppCliError("Protected-resource metadata did not advertise an authorization server");
  }

  const { body: authorizationServerMetadataBody } = await fetchJson(
    `${authorizationServer}/.well-known/oauth-authorization-server`
  );
  const authorizationServerMetadata = (authorizationServerMetadataBody ?? {}) as AuthorizationServerMetadata;
  if (authorizationServerMetadata.issuer && normalizeUrl(authorizationServerMetadata.issuer) !== authorizationServer) {
    throw new PdppCliError(
      `Authorization-server metadata issuer mismatch: expected ${authorizationServer}, got ${authorizationServerMetadata.issuer}`
    );
  }

  return {
    advertisedAuthorizationServers,
    authorizationServer,
    authorizationServerAdvertised: advertisedAuthorizationServers.includes(authorizationServer),
    authorizationServerMetadata,
    resourceMetadata,
    rsUrl,
  };
}

const TRAILING_SLASHES = /\/+$/;

function normalizeUrl(value: unknown): string {
  return String(value).replace(TRAILING_SLASHES, "");
}
