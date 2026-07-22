// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readStoredCredential } from '@pdpp/cli';

export class CredentialError extends Error {
  constructor(code, message, exitCode = 78) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

/**
 * Load a scoped PDPP client credential from the `pdpp connect` cache.
 *
 * Owner credentials are refused by default; the adapter uses a grant-scoped bearer
 * token for PDPP reads and event-subscription management. The env-derived
 * `PDPP_OWNER_TOKEN` is never consulted.
 */
export async function loadScopedCredential(providerUrl, options = {}) {
  if (!providerUrl) {
    throw new CredentialError(
      'no_provider_url',
      'Provider URL required. Pass --provider-url <url> or set PDPP_PROVIDER_URL.',
      64
    );
  }

  let result;
  try {
    result = await readStoredCredential(providerUrl, { cacheRoot: options.cacheRoot });
  } catch (error) {
    if (error?.code === 'not_connected') {
      throw new CredentialError(
        'not_connected',
        `No scoped PDPP credential cached for ${providerUrl}. Run \`pdpp connect ${providerUrl}\` and try again.`,
        78
      );
    }
    if (error?.code === 'credential_expired') {
      throw new CredentialError(
        'credential_expired',
        `Cached PDPP credential for ${providerUrl} is expired. Run \`pdpp connect ${providerUrl}\` again.`,
        78
      );
    }
    if (error?.code === 'credential_invalid') {
      throw new CredentialError(
        'credential_invalid',
        `Cached PDPP credential for ${providerUrl} is malformed; re-run \`pdpp connect ${providerUrl}\`.`,
        78
      );
    }
    if (error?.code === 'invalid_provider_url') {
      throw new CredentialError('invalid_provider_url', error.message, 64);
    }
    throw error;
  }

  const credential = result?.credential;
  if (!credential?.access_token) {
    throw new CredentialError(
      'credential_invalid',
      `Cached PDPP credential for ${providerUrl} is missing an access token.`,
      78
    );
  }

  if (isOwnerKind(credential)) {
    throw new CredentialError(
      'owner_token_refused',
      `Cached credential for ${providerUrl} is an owner token; owner credentials are refused by the MCP adapter.`,
      77
    );
  }

  return {
    providerUrl: result.providerUrl,
    cacheFile: result.cacheFile,
    accessToken: credential.access_token,
    tokenType: credential.token_type ?? 'Bearer',
    scope: credential.scope ?? result.payload?.scope ?? null,
    grantId: credential.grant_id ?? result.payload?.grant_id ?? null,
  };
}

function isOwnerKind(credential) {
  if (!credential || typeof credential !== 'object') {
    return false;
  }
  // The PDPP audit doc names `pdpp_token_kind=owner` as the owner-distinguishing claim
  // on cached credentials. Treat any kind/role-shaped owner signal as a refusal trigger.
  const flagged = [
    credential.pdpp_token_kind,
    credential.token_kind,
    credential.kind,
    credential.role,
  ];
  return flagged.some((value) => typeof value === 'string' && value.toLowerCase() === 'owner');
}
