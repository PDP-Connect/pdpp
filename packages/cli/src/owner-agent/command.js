// `pdpp owner-agent` command surface.
//
// Subcommands:
//   onboard <entrypoint-url> [--credential-file <path>] [--client-id <id>]
//       Discover the trusted owner-agent onboarding profile, run browser-
//       mediated owner approval, and write the issued owner-agent credential to
//       a local file with 0600 permissions. The bearer is never printed.
//   status [--credential-file <path>] [--entrypoint <url>]
//       Introspect the stored credential and print only non-secret status.
//   revoke [--credential-file <path>] [--entrypoint <url>]
//       Revoke the stored credential via RFC 7592 client delete.
//
// This command is owner-level local automation, distinct from the grant-scoped
// `pdpp connect` path. It must never present owner bearers as the default path
// for ordinary agents or external MCP clients.

import { parseArgs } from '../ref/args.js';

import { resolveCredentialFile, writeOwnerAgentCredential, buildCredentialRecord } from './credential-store.js';
import { discoverOwnerAgentProfile, normalizeEntrypointUrl } from './discovery.js';
import { initiateDeviceAuthorization, pollForOwnerAgentToken } from './device-flow.js';
import { OwnerAgentError } from './errors.js';
import { introspectOwnerAgentCredential, readCredentialRecord, revokeOwnerAgentCredential } from './lifecycle.js';

const USAGE = `Trusted owner-agent onboarding (owner-level local automation):
  pdpp owner-agent onboard <entrypoint-url> [--credential-file <path>] [--client-id <id>]
  pdpp owner-agent status [--credential-file <path>] [--entrypoint <url>]
  pdpp owner-agent revoke [--credential-file <path>] [--entrypoint <url>]

Notes:
  This is a deliberate local-admin mode, not the default agent path. Ordinary
  agents should use grant-scoped access (pdpp connect). The issued bearer is
  written to a local file with 0600 permissions and is never printed.
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

  const clientId = typeof flags['client-id'] === 'string' ? flags['client-id'] : undefined;
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
  out.write(`  resource: ${record.resource}\n`);
  if (record.credential.expires_at) {
    out.write(`  expires: ${record.credential.expires_at}\n`);
  }
  if (record.registration_client_uri) {
    out.write('  revocation: RFC 7592 client delete handle stored\n');
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

async function runRevoke(argv, { out }, deps) {
  const { record, targetPath } = await loadRecord(argv, deps);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const result = await revokeOwnerAgentCredential({ fetchFn, record });
  out.write(
    result.already_absent
      ? `Owner-agent credential already absent at the authorization server (${targetPath}).\n`
      : `Owner-agent credential revoked (${targetPath}).\n`
  );
  return 0;
}

async function loadRecord(argv, deps) {
  const { flags } = parseArgs(argv);
  const credentialFile = typeof flags['credential-file'] === 'string' ? flags['credential-file'] : undefined;
  const entrypoint = typeof flags.entrypoint === 'string' ? normalizeEntrypointUrl(flags.entrypoint) : null;
  const targetPath = resolveCredentialFile({
    credentialFile,
    resource: entrypoint ?? 'https://owner-agent.invalid',
    home: deps.home,
  });
  const record = await readCredentialRecord(targetPath);
  return { record, targetPath };
}

export { USAGE as OWNER_AGENT_USAGE };
