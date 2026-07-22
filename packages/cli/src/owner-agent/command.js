// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `pdpp owner-agent` command surface.
//
// Subcommands:
//   onboard <entrypoint-url> [--credential-file <path>] [--client-id <id>]
//       Discover the trusted owner-agent onboarding profile, run browser-
//       mediated owner approval, and write the issued owner-agent credential to
//       a local file with 0600 permissions. The bearer is never printed.
//   status [--credential-file <path>] [--entrypoint <url>]
//       Introspect the stored credential and print only non-secret status.
//   control [--credential-file <path>] [--entrypoint <url>]
//       Discover non-secret owner-agent control capabilities (the
//       GET /v1/owner/control capability document) and list configured
//       connection instances (GET /v1/owner/connections) with their
//       connection_id, connector identity, and label/label-needed state. The
//       bearer is sent as an Authorization header and never printed.
//   revoke [--credential-file <path>] [--entrypoint <url>]
//       Revoke the stored credential via owner-session-gated RFC 7592 client
//       delete. Uses the cached `pdpp ref login` owner session when present.
//
// This command is owner-level local automation, distinct from the grant-scoped
// `pdpp connect` path. It must never present owner bearers as the default path
// for ordinary agents or external MCP clients.

import { parseArgs } from '../ref/args.js';
import { ownerSessionHeaders } from '../ref/fetch.js';

import { resolveCredentialFile, writeOwnerAgentCredential, buildCredentialRecord } from './credential-store.js';
import { discoverOwnerAgentControl, formatOwnerAgentControl } from './control.js';
import {
  findConnectorTemplates,
  formatConnectionSetupPlan,
  formatConnectorTemplateExplain,
  formatConnectorTemplates,
  requestConnectionSetupPlan,
  requestConnectorTemplates,
} from './setup.js';
import { discoverOwnerAgentProfile, normalizeEntrypointUrl } from './discovery.js';
import { initiateDeviceAuthorization, pollForOwnerAgentToken } from './device-flow.js';
import { OwnerAgentError } from './errors.js';
import { introspectOwnerAgentCredential, readCredentialRecord, revokeOwnerAgentCredential } from './lifecycle.js';

const USAGE = `Trusted owner-agent onboarding (owner-level local automation):
  pdpp owner-agent onboard <entrypoint-url> [--credential-file <path>] [--client-id <id>] [--client-name <name>]
  pdpp owner-agent status  [--credential-file <path>] [--entrypoint <url>]
  pdpp owner-agent control [--credential-file <path>] [--entrypoint <url>]
  pdpp owner-agent connectors list|search <query>|explain <connector-id> [--credential-file <path>] [--entrypoint <url>]
  pdpp owner-agent setup   <connector-id> [--display-name <name>] [--credential-file <path>] [--entrypoint <url>]
  pdpp owner-agent revoke  [--credential-file <path>] [--entrypoint <url>] [--cache-root <dir>] [--owner-session <cookie>]

Notes:
  This is a deliberate local-admin mode, not the default agent path. Ordinary
  agents should use grant-scoped access (pdpp connect). The issued bearer is
  written to a local file with 0600 permissions and is never printed.
  "control" lists non-secret control capabilities and configured connections
  (connection_id, connector, label/label-needed); it never prints the bearer.
  "connectors" lists/searches/explains available source setup options from the
  non-secret connector-template catalog. It is read-only and does not mint
  enrollment codes or provider credentials.
  "setup" requests the same non-secret connection setup plan and next-step
  contract the console and owner-agent REST surface, from the shared server
  planner (POST /v1/owner/connections/intents); it never prints the bearer and
  never returns provider secrets.
  Revocation uses the owner-session-gated dashboard/RFC 7592 path; run
  "pdpp ref login <authorization-server>" first if no owner session is cached.
  Daisy's first supported target: ~/applications/daisy/.pi/agent/pdpp-owner-agent.json`;

export async function runOwnerAgent(argv, io = {}, deps = {}) {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    out.write(`${USAGE}\n`);
    return 0;
  }

  try {
    if (subcommand === 'onboard') {
      return await runOnboard(rest, { out }, deps);
    }
    if (subcommand === 'status') {
      return await runStatus(rest, { out }, deps);
    }
    if (subcommand === 'control') {
      return await runControl(rest, { out }, deps);
    }
    if (subcommand === 'connectors') {
      return await runConnectors(rest, { out }, deps);
    }
    if (subcommand === 'setup') {
      return await runSetup(rest, { out }, deps);
    }
    if (subcommand === 'revoke') {
      return await runRevoke(rest, { out }, deps);
    }
    err.write(`Unknown owner-agent command: ${subcommand}\n\n${USAGE}\n`);
    return 64;
  } catch (error) {
    if (error instanceof OwnerAgentError) {
      err.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

async function runConnectors(argv, { out }, deps) {
  const { record, positionals } = await loadRecord(argv, deps);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const action = positionals[0] ?? 'list';
  const templates = await requestConnectorTemplates({ fetchFn, record });

  if (action === 'list') {
    out.write(formatConnectorTemplates(templates));
    return 0;
  }
  if (action === 'search') {
    const query = positionals.slice(1).join(' ').trim();
    if (!query) {
      throw new OwnerAgentError(
        'invalid_request',
        'Usage: pdpp owner-agent connectors search <query> [--credential-file <path>] [--entrypoint <url>]',
        64
      );
    }
    out.write(formatConnectorTemplates(templates, { query }));
    return 0;
  }
  if (action === 'explain') {
    const connectorId = positionals[1];
    if (typeof connectorId !== 'string' || !connectorId.trim()) {
      throw new OwnerAgentError(
        'invalid_request',
        'Usage: pdpp owner-agent connectors explain <connector-id> [--credential-file <path>] [--entrypoint <url>]',
        64
      );
    }
    const matches = findConnectorTemplates(templates, connectorId);
    const exact = matches.find((template) => {
      const key = template?.connector_key ?? template?.connector_id;
      return typeof key === 'string' && key.toLowerCase() === connectorId.trim().toLowerCase();
    });
    out.write(formatConnectorTemplateExplain(exact ?? matches[0] ?? null));
    return 0;
  }

  throw new OwnerAgentError(
    'invalid_request',
    `Unknown owner-agent connectors command: ${action}\n\n${USAGE}`,
    64
  );
}

async function runOnboard(argv, { out }, deps) {
  const { flags, positionals } = parseArgs(argv);
  const entrypoint = normalizeEntrypointUrl(positionals[0]);
  if (!entrypoint) {
    throw new OwnerAgentError(
      'invalid_entrypoint',
      'Usage: pdpp owner-agent onboard <entrypoint-url> [--credential-file <path>]',
      64
    );
  }
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());

  const profile = await discoverOwnerAgentProfile(entrypoint, { fetch: fetchFn });

  const explicitClientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined;
  const registeredClient = explicitClientId
    ? { client_id: explicitClientId, client_name: null }
    : await registerOwnerAgentClient({
        fetchFn,
        endpoint: profile.registrationEndpoint,
        clientName:
          typeof flags['client-name'] === 'string' && flags['client-name'].trim()
            ? flags['client-name'].trim()
            : 'PDPP trusted owner agent',
      });
  const clientId = registeredClient.client_id;
  const registrationClientUri = buildRegistrationClientUri(profile, clientId);
  const device = await initiateDeviceAuthorization({
    fetchFn,
    endpoint: profile.deviceAuthorizationEndpoint,
    clientId,
  });

  // Print only non-secret approval instructions.
  out.write('Trusted owner-agent onboarding (owner-level local automation).\n');
  out.write(`Open this URL in a browser to approve owner-agent access:\n${device.verificationUri}\n`);
  if (device.userCode) {
    out.write(`Verification code: ${device.userCode}\n`);
  }
  out.write('Waiting for owner approval...\n');

  const credential = await pollForOwnerAgentToken({
    fetchFn,
    endpoint: profile.tokenEndpoint,
    clientId,
    deviceCode: device.deviceCode,
    intervalMs: device.intervalMs,
    timeoutMs: device.expiresInMs,
    sleep: deps.sleep,
    now,
    onPending: deps.onPending,
  });

  const record = buildCredentialRecord({
    resource: profile.resource,
    authorizationServer: profile.authorizationServer,
    credential,
    clientId,
    introspectionEndpoint: profile.introspectionEndpoint,
    registrationEndpoint: profile.registrationEndpoint,
    registrationClientUri,
    schemaEndpoint: profile.schemaEndpoint,
    schemaCompactEndpoint: profile.schemaCompactEndpoint,
    streamsEndpoint: profile.streamsEndpoint,
    createdAt: new Date(now()).toISOString(),
  });

  const targetPath = resolveCredentialFile({
    credentialFile: typeof flags['credential-file'] === 'string' ? flags['credential-file'] : undefined,
    resource: profile.resource,
    home: deps.home,
  });
  await writeOwnerAgentCredential(targetPath, record);

  // Non-secret status only. Never print credential.access_token.
  out.write(`Owner-agent credential stored at ${targetPath} (mode 0600)\n`);
  out.write(`  token kind: ${record.pdpp_token_kind}\n`);
  if (record.client_id) {
    out.write(`  client id: ${record.client_id}\n`);
  }
  out.write(`  resource: ${record.resource}\n`);
  if (record.expires_at) {
    out.write(`  expires: ${record.expires_at}\n`);
  }
  if (record.registration_client_uri) {
    out.write('  revocation: owner-session-gated RFC 7592 client delete handle stored\n');
  }
  out.write('Note: /mcp rejects owner bearers; this credential is for owner-level REST/control-plane use.\n');
  return 0;
}

async function runStatus(argv, { out }, deps) {
  const { record } = await loadRecord(argv, deps);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const introspection = await introspectOwnerAgentCredential({ fetchFn, record });
  out.write(`active: ${introspection.active}\n`);
  if (introspection.token_kind) out.write(`token kind: ${introspection.token_kind}\n`);
  if (introspection.sub) out.write(`subject: ${introspection.sub}\n`);
  if (introspection.client_id) out.write(`client id: ${introspection.client_id}\n`);
  if (introspection.exp) out.write(`expires (epoch): ${introspection.exp}\n`);
  return introspection.active ? 0 : 1;
}

async function runControl(argv, { out }, deps) {
  const { record } = await loadRecord(argv, deps);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const { control, connections } = await discoverOwnerAgentControl({ fetchFn, record });
  out.write(formatOwnerAgentControl({ control, connections }));
  return 0;
}

async function runSetup(argv, { out }, deps) {
  const { record, flags, positionals } = await loadRecord(argv, deps);
  const connectorId = positionals[0];
  if (typeof connectorId !== 'string' || !connectorId.trim()) {
    throw new OwnerAgentError(
      'invalid_request',
      'Usage: pdpp owner-agent setup <connector-id> [--display-name <name>] [--credential-file <path>] [--entrypoint <url>]',
      64
    );
  }
  const displayName = typeof flags['display-name'] === 'string' ? flags['display-name'] : null;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const plan = await requestConnectionSetupPlan({ fetchFn, record, connectorId, displayName });
  out.write(formatConnectionSetupPlan(plan));
  return 0;
}

async function runRevoke(argv, { out }, deps) {
  const { record, targetPath, flags } = await loadRecord(argv, deps);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const ownerSession = ownerSessionHeaders({
    ownerSession: flags['owner-session'] || '',
    referenceUrl: record.authorization_server,
    cacheRoot: flags['cache-root'],
  }).Cookie;
  const result = await revokeOwnerAgentCredential({ fetchFn, record, ownerSessionCookie: ownerSession });
  out.write(
    result.already_absent
      ? `Owner-agent credential already absent at the authorization server (${targetPath}).\n`
      : `Owner-agent credential revoked (${targetPath}).\n`
  );
  return 0;
}

async function loadRecord(argv, deps) {
  const { flags, positionals } = parseArgs(argv);
  const credentialFile = typeof flags['credential-file'] === 'string' ? flags['credential-file'] : undefined;
  const entrypoint = typeof flags.entrypoint === 'string' ? normalizeEntrypointUrl(flags.entrypoint) : null;
  const targetPath = resolveCredentialFile({
    credentialFile,
    resource: entrypoint ?? 'https://owner-agent.invalid',
    home: deps.home,
  });
  const record = await readCredentialRecord(targetPath);
  return { record, targetPath, flags, positionals };
}

export { USAGE as OWNER_AGENT_USAGE };

async function registerOwnerAgentClient({ fetchFn, endpoint, clientName }) {
  if (!endpoint) {
    throw new OwnerAgentError(
      'registration_unavailable',
      'Owner-agent onboarding requires a registration_endpoint, or pass --client-id for an existing public client.'
    );
  }
  let response;
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_name: clientName,
        token_endpoint_auth_method: 'none',
      }),
    });
  } catch (error) {
    throw new OwnerAgentError('registration_failed', `Dynamic client registration failed: ${error.message}.`);
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    const code = json?.error?.code ?? json?.error ?? `http_${response.status}`;
    throw new OwnerAgentError('registration_failed', `Dynamic client registration failed (${code}).`);
  }
  if (!json?.client_id) {
    throw new OwnerAgentError('registration_invalid', 'Dynamic client registration response did not include client_id.');
  }
  return json;
}

function buildRegistrationClientUri(profile, clientId) {
  if (!(profile && clientId)) {
    return null;
  }
  if (profile.revocationPathTemplate) {
    return profile.revocationPathTemplate.replace('{client_id}', encodeURIComponent(clientId));
  }
  if (profile.registrationEndpoint) {
    const base = profile.registrationEndpoint.endsWith('/')
      ? profile.registrationEndpoint
      : `${profile.registrationEndpoint}/`;
    return `${base}${encodeURIComponent(clientId)}`;
  }
  return null;
}
