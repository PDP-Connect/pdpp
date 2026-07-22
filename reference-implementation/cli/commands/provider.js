// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs, requirePositional } from '../lib/args.js';
import { readJsonInput, resolveInitialAccessToken } from '../lib/common.js';
import { PdppUsageError } from '../lib/errors.js';
import { discoverProvider } from '../lib/discovery.js';
import { attachReferenceQueryMetadata, fetchJson } from '../lib/fetch.js';
import { resolveFormat, writeData } from '../lib/output.js';

export async function runProvider(argv) {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);

  if (subcommand === 'show') {
    if (!flags['rs-url']) {
      throw new PdppUsageError('Missing required flag: --rs-url');
    }

    const discovered = await discoverProvider(flags);
    const metadata = discovered.authorizationServerMetadata;
    const summary = {
      object: 'provider_metadata',
      resource_server: discovered.rsUrl,
      authorization_server: discovered.authorizationServer,
      authorization_servers_advertised: discovered.advertisedAuthorizationServers,
      authorization_server_advertised: discovered.authorizationServerAdvertised,
      resource_name: discovered.resourceMetadata.resource_name || null,
      pdpp_provider_connect_version: discovered.resourceMetadata.pdpp_provider_connect_version || null,
      pdpp_self_export_supported: discovered.resourceMetadata.pdpp_self_export_supported ?? null,
      pdpp_token_kinds_supported: discovered.resourceMetadata.pdpp_token_kinds_supported || [],
      pdpp_core_query_base: discovered.resourceMetadata.pdpp_core_query_base || null,
      device_authorization_supported: !!metadata.device_authorization_endpoint,
      pushed_authorization_request_supported: !!metadata.pushed_authorization_request_endpoint,
      introspection_supported: !!metadata.introspection_endpoint,
      pushed_authorization_request_endpoint: metadata.pushed_authorization_request_endpoint || null,
      token_endpoint: metadata.token_endpoint || null,
      token_endpoint_auth_methods_supported: metadata.token_endpoint_auth_methods_supported || [],
      device_authorization_endpoint: metadata.device_authorization_endpoint || null,
      pdpp_provider_connect_capabilities: metadata.pdpp_provider_connect_capabilities || [],
      pdpp_authorization_details_types_supported: metadata.pdpp_authorization_details_types_supported || [],
      grant_types_supported: metadata.grant_types_supported || [],
    };

    if ('authorization_endpoint' in metadata) {
      summary.authorization_endpoint = metadata.authorization_endpoint;
    }
    if ('response_types_supported' in metadata) {
      summary.response_types_supported = metadata.response_types_supported;
    }
    if ('code_challenge_methods_supported' in metadata) {
      summary.code_challenge_methods_supported = metadata.code_challenge_methods_supported;
    }
    if ('registration_endpoint' in metadata) {
      summary.registration_endpoint = metadata.registration_endpoint;
    }

    if (Array.isArray(metadata.pdpp_registration_modes_supported) && metadata.pdpp_registration_modes_supported.length) {
      summary.pdpp_registration_modes_supported = metadata.pdpp_registration_modes_supported;
    }
    if ('client_id_metadata_document_supported' in metadata) {
      summary.client_id_metadata_document_supported = metadata.client_id_metadata_document_supported;
    }

    writeData(summary, resolveFormat(flags, 'table', 'json'));
    return;
  }

  if (subcommand === 'register') {
    const source = requirePositional(positionals, 0, 'path-or--');
    const initialAccessToken = resolveInitialAccessToken(flags);

    const discovered = await discoverProvider(flags);
    const registrationEndpoint = discovered.authorizationServerMetadata.registration_endpoint;
    if (!registrationEndpoint) {
      throw new PdppUsageError('Provider does not advertise a registration_endpoint');
    }

    const metadata = readJsonInput(source);
    const { body, headers } = await fetchJson(registrationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(initialAccessToken ? { Authorization: `Bearer ${initialAccessToken}` } : {}),
      },
      body: JSON.stringify(metadata),
    });
    writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, 'json', 'json'));
    return;
  }

  throw new PdppUsageError(
    'Usage: pdpp provider <show|register> ...\n' +
    '  show --rs-url <url> [--as-url <url>] [--format json|table]\n' +
    '  register <path-or-> --rs-url <url> [--as-url <url>] [--initial-access-token <token>] [--format json|table]'
  );
}
