// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DCR policy configuration for the reference AS.
 *
 * Concept: DCR (Dynamic Client Registration) policy configuration — whether DCR
 * is enabled, which initial-access tokens are provisioned, public client metadata
 * shape for the authorization-server discovery document, and a per-IP rate limiter
 * for unauthenticated (public) DCR registrations.
 *
 * Invariant: no import from index.js (no back-edge). Reads DCR config from
 * env/opts; does NOT issue, mint, or cryptographically validate any security
 * token. The provisioned initial-access-token strings are opaque config values
 * that auth.js compares at registration time.
 *
 * Scope: owns DCR policy config and the public-client rate limiter. Does NOT
 * own token issuance (stays in auth.js) or AS metadata construction (stays in
 * metadata.ts + routes/root-and-discovery.ts).
 */

import {
  DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN,
  DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS,
} from './reference-local-defaults.ts';
import { isLocalOrPrivateRequestOrigin } from './metadata.ts';

const PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION = process.env.PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION !== '0';
const PDPP_DCR_INITIAL_ACCESS_TOKENS = (process.env.PDPP_DCR_INITIAL_ACCESS_TOKENS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const PUBLIC_DCR_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const PUBLIC_DCR_RATE_LIMIT_MAX = 120;

function defaultPreRegisteredPublicClients() {
  // Copy the shared frozen defaults into plain mutable entries so downstream
  // code that mutates metadata during seeding can operate normally.
  return DEFAULT_PRE_REGISTERED_PUBLIC_CLIENTS.map((client) => ({
    ...client,
    metadata: { ...client.metadata },
  }));
}

export function resolveDynamicClientRegistrationEnabled(opts = {}) {
  const requested = opts.enableDynamicClientRegistration ?? PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION;
  return Boolean(requested);
}

export function resolveDynamicClientRegistrationInitialAccessTokens(opts = {}) {
  // Explicit opts win, including an explicit empty array for tests that want
  // public self-registration without accepting bootstrap tokens.
  if (Array.isArray(opts.dynamicClientRegistrationInitialAccessTokens)) {
    return opts.dynamicClientRegistrationInitialAccessTokens.filter(Boolean);
  }
  if (PDPP_DCR_INITIAL_ACCESS_TOKENS.length > 0) {
    return PDPP_DCR_INITIAL_ACCESS_TOKENS;
  }
  // Reference-local convenience: if the operator has not configured an
  // initial access token through env or opts, fall back to the shared local
  // default so DCR is usable by default in the forkable reference setup.
  // Explicit `PDPP_ENABLE_DYNAMIC_CLIENT_REGISTRATION=0` still disables DCR
  // via `resolveDynamicClientRegistrationEnabled`.
  return [DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN];
}

export function resolveDynamicClientRegistrationInitialAccessTokensForRequest(req, tokens) {
  if (isLocalOrPrivateRequestOrigin(req)) {
    return tokens;
  }
  return tokens.filter((token) => token !== DEFAULT_LOCAL_DCR_INITIAL_ACCESS_TOKEN);
}

export function resolvePreRegisteredPublicClients(opts = {}) {
  return opts.preRegisteredPublicClients || defaultPreRegisteredPublicClients();
}

export function createPublicDcrRateLimiter(config = {}) {
  if (config === false) {
    return { check: () => null };
  }
  const windowMs = Number.isFinite(config.windowMs)
    ? Math.max(1, config.windowMs)
    : PUBLIC_DCR_RATE_LIMIT_WINDOW_MS;
  const max = Number.isFinite(config.max)
    ? Math.max(1, config.max)
    : PUBLIC_DCR_RATE_LIMIT_MAX;
  const attempts = new Map();

  return {
    check(req) {
      const now = Date.now();
      if (attempts.size > 1000) {
        for (const [key, entry] of attempts.entries()) {
          if (entry.resetAt <= now) attempts.delete(key);
        }
      }
      const key =
        req.ip ||
        req.socket?.remoteAddress ||
        req.connection?.remoteAddress ||
        'unknown';
      const current = attempts.get(key);
      if (!current || current.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + windowMs });
        return null;
      }
      if (current.count >= max) {
        return Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      }
      current.count += 1;
      return null;
    },
  };
}

export function publicClientMetadataForAuthorizationServer(clients = []) {
  return clients
    .map((client) => {
      const clientId = typeof client.client_id === 'string' ? client.client_id.trim() : '';
      if (!clientId) {
        return null;
      }
      const metadata = client.metadata || {};
      const clientName =
        typeof metadata.client_name === 'string' && metadata.client_name.trim()
          ? metadata.client_name.trim()
          : clientId;
      const tokenEndpointAuthMethod =
        typeof metadata.token_endpoint_auth_method === 'string' &&
        metadata.token_endpoint_auth_method.trim()
          ? metadata.token_endpoint_auth_method.trim()
          : 'none';
      return {
        client_id: clientId,
        client_name: clientName,
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      };
    })
    .filter(Boolean);
}
