// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CliFlags } from "../lib/args.ts";
import { parseArgs, requirePositional } from "../lib/args.ts";
import { readJsonInput, resolveInitialAccessToken } from "../lib/common.ts";
import type { AuthorizationServerMetadata, DiscoveredProvider } from "../lib/discovery.ts";
import { discoverProvider } from "../lib/discovery.ts";
import { PdppUsageError } from "../lib/errors.ts";
import { attachReferenceQueryMetadata, fetchJson } from "../lib/fetch.ts";
import { resolveFormat, writeData } from "../lib/output.ts";

// The rendered `pdpp provider show` summary. The base fields are always
// present (defaulted from the discovery response); the OAuth-optional
// fields below are added only when the authorization server actually
// advertised them, mirroring RFC 8414's "advertise only what you support"
// contract (see the `'field' in metadata` guards below).
interface ProviderSummary {
  authorization_endpoint?: string;
  authorization_server: string;
  authorization_server_advertised: boolean;
  authorization_servers_advertised: string[];
  client_id_metadata_document_supported?: boolean;
  code_challenge_methods_supported?: string[];
  device_authorization_endpoint: string | null;
  device_authorization_supported: boolean;
  grant_types_supported: string[];
  introspection_supported: boolean;
  object: "provider_metadata";
  pdpp_authorization_details_types_supported: string[];
  pdpp_core_query_base: string | null;
  pdpp_provider_connect_capabilities: string[];
  pdpp_provider_connect_version: string | null;
  pdpp_registration_modes_supported?: string[];
  pdpp_self_export_supported: boolean | null;
  pdpp_token_kinds_supported: string[];
  pushed_authorization_request_endpoint: string | null;
  pushed_authorization_request_supported: boolean;
  registration_endpoint?: string;
  resource_name: string | null;
  resource_server: string;
  response_types_supported?: string[];
  token_endpoint: string | null;
  token_endpoint_auth_methods_supported: string[];
}

function baseProviderSummary(discovered: DiscoveredProvider): ProviderSummary {
  const metadata = discovered.authorizationServerMetadata;
  return {
    authorization_server: discovered.authorizationServer,
    authorization_server_advertised: discovered.authorizationServerAdvertised,
    authorization_servers_advertised: discovered.advertisedAuthorizationServers,
    device_authorization_endpoint: metadata.device_authorization_endpoint || null,
    device_authorization_supported: !!metadata.device_authorization_endpoint,
    grant_types_supported: metadata.grant_types_supported || [],
    introspection_supported: !!metadata.introspection_endpoint,
    object: "provider_metadata",
    pdpp_authorization_details_types_supported: metadata.pdpp_authorization_details_types_supported || [],
    pdpp_core_query_base: discovered.resourceMetadata.pdpp_core_query_base || null,
    pdpp_provider_connect_capabilities: metadata.pdpp_provider_connect_capabilities || [],
    pdpp_provider_connect_version: discovered.resourceMetadata.pdpp_provider_connect_version || null,
    pdpp_self_export_supported: discovered.resourceMetadata.pdpp_self_export_supported ?? null,
    pdpp_token_kinds_supported: discovered.resourceMetadata.pdpp_token_kinds_supported || [],
    pushed_authorization_request_endpoint: metadata.pushed_authorization_request_endpoint || null,
    pushed_authorization_request_supported: !!metadata.pushed_authorization_request_endpoint,
    resource_name: discovered.resourceMetadata.resource_name || null,
    resource_server: discovered.rsUrl,
    token_endpoint: metadata.token_endpoint || null,
    token_endpoint_auth_methods_supported: metadata.token_endpoint_auth_methods_supported || [],
  };
}

// Adds the OAuth-optional fields to a provider summary in place — only those
// the authorization server actually advertised (RFC 8414's
// "advertise only what you support" contract). Extracted from
// runProviderShow only to keep its own cognitive complexity in budget;
// behavior (which fields, guarded how) is unchanged.
function applyOptionalProviderFields(summary: ProviderSummary, metadata: AuthorizationServerMetadata): void {
  if ("authorization_endpoint" in metadata && metadata.authorization_endpoint !== undefined) {
    summary.authorization_endpoint = metadata.authorization_endpoint;
  }
  if ("response_types_supported" in metadata && metadata.response_types_supported !== undefined) {
    summary.response_types_supported = metadata.response_types_supported;
  }
  if ("code_challenge_methods_supported" in metadata && metadata.code_challenge_methods_supported !== undefined) {
    summary.code_challenge_methods_supported = metadata.code_challenge_methods_supported;
  }
  if ("registration_endpoint" in metadata && metadata.registration_endpoint !== undefined) {
    summary.registration_endpoint = metadata.registration_endpoint;
  }
  if (Array.isArray(metadata.pdpp_registration_modes_supported) && metadata.pdpp_registration_modes_supported.length) {
    summary.pdpp_registration_modes_supported = metadata.pdpp_registration_modes_supported;
  }
  if (
    "client_id_metadata_document_supported" in metadata &&
    metadata.client_id_metadata_document_supported !== undefined
  ) {
    summary.client_id_metadata_document_supported = metadata.client_id_metadata_document_supported;
  }
}

async function runProviderShow(flags: CliFlags): Promise<void> {
  if (!flags["rs-url"]) {
    throw new PdppUsageError("Missing required flag: --rs-url");
  }

  const discovered = await discoverProvider(flags);
  const summary = baseProviderSummary(discovered);
  applyOptionalProviderFields(summary, discovered.authorizationServerMetadata);

  writeData(summary, resolveFormat(flags, "table", "json"));
}

async function runProviderRegister(positionals: string[], flags: CliFlags): Promise<void> {
  const source = requirePositional(positionals, 0, "path-or--");
  const initialAccessToken = resolveInitialAccessToken(flags);

  const discovered = await discoverProvider(flags);
  const registrationEndpoint: string | undefined = discovered.authorizationServerMetadata.registration_endpoint;
  if (!registrationEndpoint) {
    throw new PdppUsageError("Provider does not advertise a registration_endpoint");
  }

  const metadata = readJsonInput(source);
  const { body, headers } = await fetchJson(registrationEndpoint, {
    body: JSON.stringify(metadata),
    headers: {
      "Content-Type": "application/json",
      ...(initialAccessToken ? { Authorization: `Bearer ${initialAccessToken}` } : {}),
    },
    method: "POST",
  });
  writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, "json", "json"));
}

// Async to keep a uniform Promise<void> signature across index.ts's
// COMMANDS dispatch table; each branch returns another handler's promise
// directly (no local await needed).
// biome-ignore lint/suspicious/useAwait: see comment above
export async function runProvider(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);

  if (subcommand === "show") {
    return runProviderShow(flags);
  }

  if (subcommand === "register") {
    return runProviderRegister(positionals, flags);
  }

  throw new PdppUsageError(
    "Usage: pdpp provider <show|register> ...\n" +
      "  show --rs-url <url> [--as-url <url>] [--format json|table]\n" +
      "  register <path-or-> --rs-url <url> [--as-url <url>] [--initial-access-token <token>] [--format json|table]"
  );
}
