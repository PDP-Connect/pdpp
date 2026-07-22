// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from '../lib/args.js';
import { resolveAsUrl } from '../lib/common.js';
import { discoverProvider } from '../lib/discovery.js';
import { PdppCliError, PdppHttpError, PdppUsageError } from '../lib/errors.js';
import { attachReferenceQueryMetadata, fetchJson } from '../lib/fetch.js';
import { resolveFormat, writeData } from '../lib/output.js';

export async function runAuth(argv) {
  const [subcommand, ...rest] = argv;
  const { flags } = parseArgs(rest);

  if (subcommand === 'introspect') {
    const token = flags.token || process.env.PDPP_OWNER_TOKEN || process.env.PDPP_CLIENT_TOKEN;
    if (!token || token === true) {
      throw new PdppUsageError('Missing required flag: --token');
    }

    const authSurface = await resolveAuthSurface(flags, {
      requireIntrospectionEndpoint: true,
    });

    const { body } = await fetchJson(`${authSurface.introspectionEndpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    writeData(body, resolveFormat(flags, 'json', 'json'));
    return;
  }

  if (subcommand === 'login') {
    const authSurface = await resolveAuthSurface(flags, {
      requireDeviceAuthorizationEndpoint: true,
      requireTokenEndpoint: true,
      requireSelfExportCapabilities: true,
    });
    const clientId = flags['client-id'] || 'pdpp-cli';
    const timeoutSeconds = Math.max(parseInt(flags['timeout-seconds'] || '300', 10) || 300, 1);

    const { body: device } = await fetchJson(authSurface.deviceAuthorizationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId }).toString(),
    });

    process.stderr.write(`Verification URI: ${device.verification_uri_complete || device.verification_uri}\n`);
    process.stderr.write(`User code: ${device.user_code}\n`);

    let intervalMs = Math.max((device.interval || 5) * 1000, 1000);
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      await sleep(intervalMs);
      try {
        const { body, headers } = await fetchJson(authSurface.tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: device.device_code,
            client_id: clientId,
          }).toString(),
        });
        writeData(attachReferenceQueryMetadata(body, headers), resolveFormat(flags, 'json', 'json'));
        return;
      } catch (error) {
        if (!(error instanceof PdppHttpError)) {
          throw error;
        }

        const oauthCode = error.body?.error;
        if (oauthCode === 'authorization_pending') {
          continue;
        }
        if (oauthCode === 'slow_down') {
          intervalMs += 5000;
          continue;
        }
        throw new PdppCliError(
          error.body?.error_description || error.message,
          error.exitCode,
          error.details
        );
      }
    }

    throw new PdppCliError('Timed out waiting for owner approval');
  }

  throw new PdppUsageError(
    'Usage: pdpp auth <introspect|login> ...\n' +
    '  introspect --token <token> [--as-url <url> | --rs-url <url>] [--format json|table]\n' +
    '  login [--client-id <id>] [--as-url <url> | --rs-url <url>] [--timeout-seconds <n>] [--format json]'
  );
}

async function resolveAuthSurface(flags, requirements = {}) {
  if (flags['as-url']) {
    const asUrl = resolveAsUrl(flags);
    return {
      issuer: asUrl,
      introspectionEndpoint: `${asUrl}/introspect`,
      tokenEndpoint: `${asUrl}/oauth/token`,
      deviceAuthorizationEndpoint: `${asUrl}/oauth/device_authorization`,
    };
  }

  if (flags['rs-url']) {
    const discovered = await discoverProvider(flags);
    const metadata = discovered.authorizationServerMetadata;
    const resourceMetadata = discovered.resourceMetadata;
    const surface = {
      issuer: discovered.authorizationServer,
      introspectionEndpoint: metadata.introspection_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      deviceAuthorizationEndpoint: metadata.device_authorization_endpoint,
    };

    if (requirements.requireSelfExportCapabilities) {
      if (resourceMetadata.pdpp_self_export_supported !== true) {
        throw new PdppCliError('Protected-resource metadata does not advertise pdpp_self_export_supported=true');
      }
      if (!Array.isArray(resourceMetadata.pdpp_token_kinds_supported) || !resourceMetadata.pdpp_token_kinds_supported.includes('owner')) {
        throw new PdppCliError('Protected-resource metadata does not advertise owner token support');
      }
      const capabilities = Array.isArray(metadata.pdpp_provider_connect_capabilities)
        ? metadata.pdpp_provider_connect_capabilities
        : [];
      for (const capability of ['owner_self_export', 'cli_device_connect']) {
        if (!capabilities.includes(capability)) {
          throw new PdppCliError(`Authorization-server metadata does not advertise required PDPP capability: ${capability}`);
        }
      }
    }

    if (requirements.requireIntrospectionEndpoint && !surface.introspectionEndpoint) {
      throw new PdppCliError('Authorization-server metadata did not advertise an introspection endpoint');
    }
    if (requirements.requireTokenEndpoint && !surface.tokenEndpoint) {
      throw new PdppCliError('Authorization-server metadata did not advertise a token endpoint');
    }
    if (requirements.requireDeviceAuthorizationEndpoint && !surface.deviceAuthorizationEndpoint) {
      throw new PdppCliError('Authorization-server metadata did not advertise a device-authorization endpoint');
    }

    return surface;
  }

  const asUrl = resolveAsUrl(flags);
  return {
    issuer: asUrl,
    introspectionEndpoint: `${asUrl}/introspect`,
    tokenEndpoint: `${asUrl}/oauth/token`,
    deviceAuthorizationEndpoint: `${asUrl}/oauth/device_authorization`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
