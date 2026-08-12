// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pdpp agent — project-local agent grant management
 *
 * Subcommands:
 *   bootstrap   discover AS/RS, register a project client, write .pdpp/agent-access.json
 *   status      show cached grant scope/expiry/revocation state (never prints tokens)
 *   request     stage a PAR grant request and print the owner approval URL
 *   wait        poll the local cache until a usable token appears (no AS contact)
 *   store       accept a pasted token and write it to the local cache
 *   use         print the bearer token for a cached grant (for piping to curl)
 *   forget      remove a cached grant and token without revoking on the server
 *   revoke      revoke a grant on the AS and remove from local cache
 *
 * Protocol-candidate note: the reference has no public poll-for-approval endpoint
 * for PAR-staged client grants. `wait` polls only the local cache; another process
 * (the owner's browser + `pdpp agent store`) must write the token. AS-side consent
 * polling remains a protocol-candidate gap documented in design-notes/.
 */

import { spawnSync } from "node:child_process";
import type { CliFlags } from "../lib/args.ts";
import { parseArgs } from "../lib/args.ts";
import type { CachedClient, CachedGrant, CacheRoot } from "../lib/cache.ts";
import {
  deleteGrantFiles,
  ensureCacheDirs,
  ensureGitignore,
  hasUsableGrant,
  listClients,
  listGrants,
  readAccess,
  readGrant,
  readToken,
  redactGrantForDisplay,
  writeAccess,
  writeClient,
  writeGrant,
  writeToken,
} from "../lib/cache.ts";
import { resolveAsUrl, resolveInitialAccessToken, resolveRsUrl } from "../lib/common.ts";
import { discoverProvider } from "../lib/discovery.ts";
import { PdppCliError, PdppHttpError, PdppUsageError } from "../lib/errors.ts";
import { bearer, fetchJson } from "../lib/fetch.ts";
import { resolveFormat, writeData } from "../lib/output.ts";

const AGENT_USAGE = `Usage: pdpp agent <subcommand> [options]

Subcommands:
  bootstrap   Discover AS/RS and register a project-local public client.
  status      Show cached grant scope, expiry, and revocation state (no secrets).
  request     Stage a PAR grant request; print the owner approval URL.
  wait        Poll the local cache until a usable token appears, then exit 0.
  store       Accept a pasted client token and write it to the local cache.
  use         Print the bearer token for a named grant (pipe to curl -H "Authorization: Bearer $(...)").
  forget      Remove a cached grant and its token without revoking on the AS.
  revoke      Revoke a grant on the AS and remove it from the local cache.

Options shared by most subcommands:
  --as-url <url>         AS base URL (default: $PDPP_AS_URL or http://localhost:7662)
  --rs-url <url>         RS base URL; used to discover AS when --as-url is absent
  --cache-root <path>    Override the .pdpp/ cache root (default: <cwd>/.pdpp)
  --format json|table    Output format (default: json when piped, table when TTY)

Grant request options (pdpp agent request):
  --source-kind <kind>   connector | provider_native
  --source-id <id>       Source identifier from /v1/connectors
  --streams <s1,s2,...>  Comma-separated stream names
  --purpose <text>       Owner-readable one-sentence purpose description
  --purpose-code <code>  Machine-readable purpose code (default: assist.general)
  --access-mode <mode>   single_use | continuous (default: single_use)
  --client-id <id>       Use a specific registered client id (default: first cached client)
  --initial-access-token <token>  Optional operator/bootstrap token for DCR (default: $PDPP_INITIAL_ACCESS_TOKEN)

Wait options (pdpp agent wait):
  --grant-id <id>           Wait for a specific grant ID (default: any usable grant)
  --timeout-seconds <n>     Give up after this many seconds (default: 300)
  --interval-seconds <n>    Poll interval in seconds (default: 5)

Store options (pdpp agent store):
  --grant-id <id>        Grant ID to associate the pasted token with
  --token <token>        Opaque client token (prefer piping to avoid shell history)
`;

// Uniform Promise<void> signature across index.ts's COMMANDS dispatch table;
// every branch either throws or returns another handler's promise directly
// (no local await needed), and one branch does a bare `return` that a
// non-async function could not resolve to Promise<void> the same way.
// biome-ignore lint/suspicious/useAwait: see comment above
export async function runAgent(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);
  const cacheRoot: CacheRoot = typeof flags["cache-root"] === "string" ? flags["cache-root"] : null;

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(`${AGENT_USAGE}\n`);
    return;
  }

  if (subcommand === "bootstrap") {
    return runBootstrap(flags, cacheRoot);
  }

  if (subcommand === "status") {
    return runStatus(flags, cacheRoot);
  }

  if (subcommand === "request") {
    return runRequest(flags, cacheRoot);
  }

  if (subcommand === "wait") {
    return runWait(flags, cacheRoot);
  }

  if (subcommand === "store") {
    return runStore(flags, cacheRoot);
  }

  if (subcommand === "use") {
    const grantId = positionals[0] || flagString(flags["grant-id"]);
    return runUse(grantId, cacheRoot);
  }

  if (subcommand === "forget") {
    const grantId = positionals[0] || flagString(flags["grant-id"]);
    if (!grantId) {
      throw new PdppUsageError("Missing grant-id: pdpp agent forget <grant-id>");
    }
    return runForget(grantId, cacheRoot);
  }

  if (subcommand === "revoke") {
    const grantId = positionals[0] || flagString(flags["grant-id"]);
    if (!grantId) {
      throw new PdppUsageError("Missing grant-id: pdpp agent revoke <grant-id>");
    }
    return runRevoke(grantId, flags, cacheRoot);
  }

  throw new PdppUsageError(`Unknown agent subcommand: ${subcommand}\n\n${AGENT_USAGE}`);
}

// A bare boolean flag (--grant-id with no value) never names a real grant
// id, so it is treated the same as absent — matching the pre-migration
// behavior where `flags['grant-id']` being `true` failed the same
// downstream "missing grant-id" checks a `string` grant id would pass.
function flagString(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface SourceFromFlags {
  id: string;
  kind: "connector" | "provider_native";
}

function requireSourceFromFlags(flags: CliFlags): SourceFromFlags {
  const kind = flags["source-kind"] || null;
  const id = flags["source-id"] || null;
  if (!(kind && id)) {
    throw new PdppUsageError("Both --source-kind <connector|provider_native> and --source-id <id> are required.");
  }
  if (kind !== "connector" && kind !== "provider_native") {
    throw new PdppUsageError("--source-kind must be connector or provider_native.");
  }
  return { id: String(id), kind };
}

// ─── bootstrap ───────────────────────────────────────────────────────────────

async function runBootstrap(flags: CliFlags, cacheRoot: CacheRoot): Promise<void> {
  await ensureCacheDirs(cacheRoot);
  await ensureGitignore(cacheRoot);

  const asUrl = String(await resolveAgentAsUrl(flags));
  const rsUrl = String(resolveRsUrl(flags));

  const existing = readAccess(cacheRoot);
  if (existing?.as_url && existing.rs_url) {
    const clients = listClients(cacheRoot);
    if (clients.length > 0) {
      process.stderr.write(`Already bootstrapped. Client IDs: ${clients.map((c) => c.client_id).join(", ")}\n`);
      process.stderr.write(`Run "pdpp agent status" to see grants, or "pdpp agent request" to stage a new one.\n`);
      writeData(
        {
          as_url: existing.as_url,
          bootstrapped: true,
          clients: clients.map((c) => ({ client_id: c.client_id, client_name: c.client_name || null })),
          rs_url: existing.rs_url,
        },
        resolveFormat(flags, "table", "json")
      );
      return;
    }
  }

  writeAccess(cacheRoot, { as_url: asUrl, rs_url: rsUrl });

  const initialAccessToken = resolveInitialAccessToken(flags);
  const projectLabel =
    flags["project-label"] || process.env.PDPP_PROJECT_LABEL || process.cwd().split("/").pop() || "agent-project";
  const clientName = `Claude Code · ${projectLabel}`;

  const registrationBody = {
    client_name: clientName,
    token_endpoint_auth_method: "none",
  };

  let registered: CachedClient;
  try {
    const reqHeaders = {
      "Content-Type": "application/json",
      ...(initialAccessToken ? { Authorization: `Bearer ${initialAccessToken}` } : {}),
    };
    const { body } = await fetchJson(`${asUrl}/oauth/register`, {
      body: JSON.stringify(registrationBody),
      headers: reqHeaders,
      method: "POST",
    });
    registered = body as CachedClient;
  } catch (err) {
    if (err instanceof PdppHttpError && (err.status === 401 || err.status === 403)) {
      // PdppCliError carries context via `details`, not the native cause
      // chain (see errors.ts); this branch replaces the HTTP error with a
      // more actionable operator message rather than wrapping it.
      // biome-ignore lint/style/useErrorCause: see comment above
      throw new PdppCliError(
        "Client registration rejected the supplied initial access token. " +
          "Omit the token for public self-registration or pass a valid operator/bootstrap token.",
        1
      );
    }
    throw err;
  }

  writeClient(cacheRoot, registered.client_id, registered);
  process.stderr.write(`Registered client: ${registered.client_id} ("${clientName}")\n`);
  process.stderr.write(`Cache root: ${cacheRoot || `${process.cwd()}/.pdpp`}\n`);
  process.stderr.write(`Run "pdpp agent request" to stage a grant.\n`);

  writeData(
    { as_url: asUrl, bootstrapped: true, client_id: registered.client_id, client_name: clientName, rs_url: rsUrl },
    resolveFormat(flags, "table", "json")
  );
}

// ─── status ──────────────────────────────────────────────────────────────────

// Async to keep a uniform Promise<void> signature callers (runAgent) return
// directly without re-wrapping; this subcommand needs no local await today.
// biome-ignore lint/suspicious/useAwait: see comment above
async function runStatus(flags: CliFlags, cacheRoot: CacheRoot): Promise<void> {
  const access = readAccess(cacheRoot);
  const grants = listGrants(cacheRoot);
  const clients = listClients(cacheRoot);

  const now = Date.now();
  const grantSummaries = grants.map((g) => {
    const hasToken = !!readToken(cacheRoot, g.grant_id);
    const expired = g.expires_at ? new Date(g.expires_at).getTime() <= now : false;
    return {
      access_mode: g.access_mode || null,
      expired,
      expires_at: g.expires_at || null,
      grant_id: g.grant_id,
      purpose_description: g.purpose_description || null,
      revoked: g.revoked,
      source: g.source || null,
      streams: (g.streams || []).map((s) => (typeof s === "string" ? s : s.name)),
      token_cached: hasToken,
      usable: hasToken && !expired && !g.revoked,
    };
  });

  const summary = {
    as_url: access?.as_url || null,
    client_count: clients.length,
    clients: clients.map((c) => ({ client_id: c.client_id, client_name: c.client_name || null })),
    grant_count: grants.length,
    grants: grantSummaries,
    last_activity: access?.last_activity || null,
    object: "agent_cache_status",
    rs_url: access?.rs_url || null,
  };

  writeData(summary, resolveFormat(flags, "table", "json"));
}

// ─── request ─────────────────────────────────────────────────────────────────

// The reference AS's PAR-staging response (POST /oauth/par): request_uri is
// always present on success; authorization_url is an optional convenience
// the reference server adds (clients can also build the consent URL
// themselves from request_uri, which the fallback below does).
interface StagedParResponse {
  authorization_url?: string;
  expires_in?: number;
  request_uri: string;
}

async function runRequest(flags: CliFlags, cacheRoot: CacheRoot): Promise<void> {
  await ensureCacheDirs(cacheRoot);
  await ensureGitignore(cacheRoot);

  const asUrl = await resolveAgentAsUrl(flags);

  const clients = listClients(cacheRoot);
  const clientId = flags["client-id"] || clients[0]?.client_id;
  if (!clientId) {
    throw new PdppUsageError('No registered client found. Run "pdpp agent bootstrap" first, or pass --client-id.');
  }
  const clientMeta = clients.find((c) => c.client_id === clientId);
  const clientName = clientMeta?.client_name || clientId;

  const source = requireSourceFromFlags(flags);

  const streamsFlag = typeof flags.streams === "string" ? flags.streams : "";
  const streamNames = streamsFlag
    ? streamsFlag
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (!streamNames.length) {
    throw new PdppUsageError("--streams is required (comma-separated stream names).");
  }

  const purposeText = flags.purpose || null;
  if (!purposeText) {
    throw new PdppUsageError(
      "--purpose is required. Write a one-sentence description the owner will see on the consent screen."
    );
  }

  const purposeCode = flags["purpose-code"] || "assist.general";
  const accessMode = flags["access-mode"] || "single_use";

  const context = flags.context || process.cwd();

  const parRequest = {
    authorization_details: [
      {
        access_mode: accessMode,
        purpose_code: purposeCode,
        purpose_description: purposeText,
        source,
        streams: streamNames.map((name) => ({ name })),
        type: "https://pdpp.dev/data-access",
      },
    ],
    client_display: {
      context,
      name: clientName,
    },
    client_id: clientId,
  };

  const { body } = await fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify(parRequest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const staged = body as StagedParResponse;

  const approvalUrl =
    staged.authorization_url || `${asUrl}/consent?request_uri=${encodeURIComponent(staged.request_uri)}`;
  const expiresIn = staged.expires_in || 300;

  process.stderr.write("\n");
  process.stderr.write("═══════════════════════════════════════════════════════\n");
  process.stderr.write("PDPP Agent Grant Request — owner approval needed\n");
  process.stderr.write("═══════════════════════════════════════════════════════\n");
  process.stderr.write(`Client:   ${clientName}\n`);
  process.stderr.write(`Source:   ${source.kind}:${source.id}\n`);
  process.stderr.write(`Streams:  ${streamNames.join(", ")}\n`);
  process.stderr.write(`Purpose:  ${purposeText}\n`);
  process.stderr.write(`Mode:     ${accessMode}\n`);
  process.stderr.write("-------------------------------------------------------\n");
  process.stderr.write("Open this URL in a browser and approve or deny:\n\n");
  process.stderr.write(`  ${approvalUrl}\n\n`);
  process.stderr.write(`This link expires in ~${Math.round(expiresIn / 60)} minutes.\n`);
  process.stderr.write("═══════════════════════════════════════════════════════\n");
  process.stderr.write("\n");
  process.stderr.write("After the owner approves, the token appears on the consent page.\n");
  process.stderr.write("Pass it to:\n");
  process.stderr.write("  pdpp agent store --grant-id <grant-id> --token <token>\n");
  process.stderr.write("\n");

  if (maybeOpenBrowser(approvalUrl)) {
    process.stderr.write("(Opened browser.)\n");
  }

  writeData(
    {
      access_mode: accessMode,
      authorization_url: approvalUrl,
      client_id: clientId,
      expires_in: expiresIn,
      object: "grant_request_staged",
      request_uri: staged.request_uri,
      source,
      streams: streamNames,
    },
    resolveFormat(flags, "table", "json")
  );
}

// ─── wait ─────────────────────────────────────────────────────────────────────

async function runWait(flags: CliFlags, cacheRoot: CacheRoot): Promise<void> {
  const grantId = flagString(flags["grant-id"]) || null;
  const timeoutSeconds = Math.max(Number.parseInt(String(flags["timeout-seconds"] || "300"), 10) || 300, 1);
  const intervalSeconds = Math.max(Number.parseInt(String(flags["interval-seconds"] || "5"), 10) || 5, 1);

  process.stderr.write(
    "Waiting for a usable token to appear in the local cache.\n" +
      "This command does NOT contact the AS. No AS polling endpoint exists yet for\n" +
      "PAR-staged client grants — that is a documented protocol-candidate gap.\n" +
      "\n" +
      "To unblock this wait:\n" +
      '  1. Open the approval URL printed by "pdpp agent request" in a browser.\n' +
      "  2. Approve the request.\n" +
      "  3. Copy the token shown on the approval page.\n" +
      "  4. In another terminal: pdpp agent store --grant-id <id> --token <token>\n" +
      "\n"
  );

  const deadline = Date.now() + timeoutSeconds * 1000;
  const intervalMs = intervalSeconds * 1000;

  while (Date.now() < deadline) {
    const found = hasUsableGrant(cacheRoot, grantId ? { grantId } : {});

    if (found) {
      const resolvedGrantId = found.grant_id || grantId;
      process.stderr.write(`Token found for grant ${resolvedGrantId}. Proceeding.\n`);
      writeData(
        { grant_id: resolvedGrantId, object: "agent_wait_result", token_cached: true },
        resolveFormat(flags, "json", "json")
      );
      return;
    }

    const remaining = Math.round((deadline - Date.now()) / 1000);
    process.stderr.write(`Waiting... (${remaining}s remaining)\r`);
    // Deliberate poll loop: each iteration must wait before re-checking the
    // cache, so the awaits are inherently sequential, not parallelizable.
    // biome-ignore lint/performance/noAwaitInLoops: see comment above
    await sleep(intervalMs);
  }

  throw new PdppCliError(
    `Timed out after ${timeoutSeconds}s waiting for a cached token. ` +
      'Run "pdpp agent store --grant-id <id> --token <token>" to store a token, then retry.',
    1
  );
}

// ─── store ────────────────────────────────────────────────────────────────────

// The reference AS's RFC 7662 introspection response body, extended with
// PDPP-specific fields. Only the fields runStore/introspectToken actually
// read are declared; everything else about a token stays opaque to the CLI.
interface IntrospectionResult {
  active: boolean;
  client_id?: string;
  exp?: number;
  grant_id?: string;
  grant_json?: {
    source?: SourceFromFlags;
    streams?: import("../lib/cache.ts").StreamRef[];
    purpose_description?: string;
    purpose_code?: string;
    access_mode?: string;
    retention?: unknown;
  };
  iat?: number;
  pdpp_token_kind?: string;
  source?: SourceFromFlags;
}

function requireRawToken(flags: CliFlags): string {
  const rawToken = flagString(flags.token) || process.env.PDPP_CLIENT_TOKEN || null;
  if (!rawToken) {
    throw new PdppUsageError(
      "Provide the token via --token <token> or $PDPP_CLIENT_TOKEN.\n" +
        "Prefer: PDPP_CLIENT_TOKEN=$(cat) pdpp agent store --grant-id <id>\n" +
        "(type the token, then Ctrl-D)"
    );
  }
  return rawToken;
}

// Validates an introspection result is an active, client-kind token before
// runStore caches it — throws with the same messages the inline checks used
// to, extracted only to keep runStore's own cognitive complexity in budget.
function requireActiveClientIntrospection(introspection: IntrospectionResult): void {
  if (!introspection.active) {
    throw new PdppCliError("Token is not active (expired or revoked). Obtain a fresh approval.");
  }
  if (introspection.pdpp_token_kind !== "client") {
    throw new PdppCliError(
      `Token is kind="${introspection.pdpp_token_kind}". Only client tokens should be stored here. ` +
        "Owner tokens must not be cached in the project-local store."
    );
  }
}

async function runStore(flags: CliFlags, cacheRoot: CacheRoot): Promise<void> {
  await ensureCacheDirs(cacheRoot);

  const asUrl = await resolveAgentAsUrl(flags);
  const grantId = flagString(flags["grant-id"]);
  const rawToken = requireRawToken(flags);

  const introspection = await introspectToken(asUrl, rawToken);
  requireActiveClientIntrospection(introspection);

  const resolvedGrantId = grantId || introspection.grant_id || null;
  if (!resolvedGrantId) {
    throw new PdppCliError(
      "Could not determine grant ID. Pass --grant-id <id> (visible on the consent approval page)."
    );
  }

  const grant = introspection.grant_json || {};
  const source = grant.source || introspection.source || null;
  const grantMeta: CachedGrant = {
    access_mode: grant.access_mode || null,
    client_id: introspection.client_id || null,
    expires_at: introspection.exp ? new Date(introspection.exp * 1000).toISOString() : null,
    grant_id: resolvedGrantId,
    issued_at: introspection.iat ? new Date(introspection.iat * 1000).toISOString() : new Date().toISOString(),
    purpose_code: grant.purpose_code || null,
    purpose_description: grant.purpose_description || null,
    retention: grant.retention || null,
    revoked: false,
    source,
    streams: grant.streams || [],
  };

  writeGrant(cacheRoot, resolvedGrantId, grantMeta);
  await writeToken(cacheRoot, resolvedGrantId, rawToken);

  writeAccess(cacheRoot, {
    ...(readAccess(cacheRoot) || {}),
    as_url: String(asUrl),
  });

  process.stderr.write(`Stored grant ${resolvedGrantId}\n`);
  process.stderr.write(
    `  Source:  ${grantMeta.source ? `${grantMeta.source.kind}:${grantMeta.source.id}` : "(unknown)"}\n`
  );
  process.stderr.write(
    `  Streams: ${(grantMeta.streams || []).map((s) => (typeof s === "string" ? s : s.name)).join(", ") || "(none)"}\n`
  );
  if (grantMeta.expires_at) {
    process.stderr.write(`  Expires: ${grantMeta.expires_at}\n`);
  }
  process.stderr.write('Token is cached. Run "pdpp agent status" to verify.\n');

  writeData(redactGrantForDisplay(grantMeta), resolveFormat(flags, "table", "json"));
}

// ─── use ──────────────────────────────────────────────────────────────────────

// Async to keep a uniform Promise<void> signature callers (runAgent) return
// directly without re-wrapping; this subcommand needs no local await today.
// biome-ignore lint/suspicious/useAwait: see comment above
async function runUse(grantId: string | undefined, cacheRoot: CacheRoot): Promise<void> {
  const resolvedGrantId = grantId || resolveDefaultGrantId(cacheRoot);
  if (!resolvedGrantId) {
    throw new PdppUsageError("No grant ID specified and no usable grant found.\nUsage: pdpp agent use <grant-id>");
  }
  const token = readToken(cacheRoot, resolvedGrantId);
  if (!token) {
    throw new PdppCliError(
      `No cached token for grant ${resolvedGrantId}. ` +
        'Run "pdpp agent store --grant-id <id> --token <token>" to cache a token.'
    );
  }
  const grant = readGrant(cacheRoot, resolvedGrantId);
  if (grant?.revoked) {
    throw new PdppCliError(
      `Grant ${resolvedGrantId} has been revoked locally. Run "pdpp agent request" to get a new grant.`
    );
  }
  if (grant?.expires_at && new Date(grant.expires_at).getTime() <= Date.now()) {
    throw new PdppCliError(`Grant ${resolvedGrantId} is expired. Run "pdpp agent request" to get a new grant.`);
  }
  process.stdout.write(token);
}

// ─── forget ───────────────────────────────────────────────────────────────────

// Async to keep a uniform Promise<void> signature callers (runAgent) return
// directly without re-wrapping; this subcommand needs no local await today.
// biome-ignore lint/suspicious/useAwait: see comment above
async function runForget(grantId: string, cacheRoot: CacheRoot): Promise<void> {
  const grant = readGrant(cacheRoot, grantId);
  deleteGrantFiles(cacheRoot, grantId);
  process.stderr.write(`Removed local cache for grant ${grantId}.\n`);
  if (grant) {
    process.stderr.write('Grant was NOT revoked on the AS. Run "pdpp agent revoke" to revoke on the server.\n');
  }
  writeData({ forgotten: true, grant_id: grantId }, "json");
}

// ─── revoke ───────────────────────────────────────────────────────────────────

async function runRevoke(grantId: string, flags: CliFlags, cacheRoot: CacheRoot): Promise<void> {
  const asUrl = await resolveAgentAsUrl(flags);
  const token = readToken(cacheRoot, grantId);

  const revokeHeaders = token ? bearer(token) : {};
  try {
    await fetchJson(`${asUrl}/grants/${encodeURIComponent(grantId)}/revoke`, {
      headers: revokeHeaders,
      method: "POST",
    });
    process.stderr.write(`Revoked grant ${grantId} on AS.\n`);
  } catch (err) {
    if (err instanceof PdppHttpError && err.status === 404) {
      process.stderr.write(`Grant ${grantId} not found on AS (may already be revoked or expired).\n`);
    } else {
      throw err;
    }
  }

  const grant = readGrant(cacheRoot, grantId);
  if (grant) {
    writeGrant(cacheRoot, grantId, { ...grant, revoked: true });
  }
  deleteGrantFiles(cacheRoot, grantId);

  process.stderr.write(`Removed local cache for grant ${grantId}.\n`);
  writeData({ grant_id: grantId, revoked: true }, "json");
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function resolveAgentAsUrl(flags: CliFlags): Promise<string | true> {
  if (flags["as-url"] || process.env.PDPP_AS_URL || process.env.AS_URL) {
    return resolveAsUrl(flags);
  }
  if (flags["rs-url"] || process.env.PDPP_RS_URL || process.env.RS_URL) {
    const discovered = await discoverProvider({ ...flags, "rs-url": resolveRsUrl(flags) });
    return discovered.authorizationServer;
  }
  const access = readAccess(null);
  if (access?.as_url) {
    return access.as_url;
  }
  return resolveAsUrl(flags);
}

async function introspectToken(asUrl: string | true, token: string): Promise<IntrospectionResult> {
  const { body } = await fetchJson(`${asUrl}/introspect`, {
    body: JSON.stringify({ token }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return body as IntrospectionResult;
}

function resolveDefaultGrantId(cacheRoot: CacheRoot): string | null {
  const grants = listGrants(cacheRoot);
  const now = Date.now();
  for (const g of grants) {
    if (g.revoked) {
      continue;
    }
    if (g.expires_at && new Date(g.expires_at).getTime() <= now) {
      continue;
    }
    if (readToken(cacheRoot, g.grant_id)) {
      return g.grant_id;
    }
  }
  return null;
}

function maybeOpenBrowser(url: string): boolean {
  if (!(process.env.PDPP_OPEN_BROWSER || process.env.BROWSER_OPEN)) {
    return false;
  }
  try {
    const { platform } = process;
    let cmd = "xdg-open";
    if (platform === "darwin") {
      cmd = "open";
    } else if (platform === "win32") {
      cmd = "start";
    }
    // `detached` has no effect on spawnSync (it only matters for the async
    // spawn(), where it controls child process-group detachment before the
    // parent can wait on it — spawnSync always blocks until the child
    // exits regardless). It was accepted at runtime as an unrecognized
    // option but is not in Node's SpawnSyncOptions type; dropped here as a
    // no-op, not a behavior change.
    spawnSync(cmd, [url], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
