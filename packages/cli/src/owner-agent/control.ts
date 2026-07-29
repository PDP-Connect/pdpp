// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Non-secret owner-agent control discovery for the `pdpp owner-agent control`
// subcommand.
//
// A trusted local owner agent (Daisy/Simon-style) needs a typed, route-guess-
// free way to answer two questions before it operates an owner's instance:
//   1. "What owner-agent control actions does this build support?" — the
//      bearer-authed capability document `GET /v1/owner/control`.
//   2. "Which connection instances are configured, and which still need an
//      owner-meaningful label?" — the bearer-authed listing
//      `GET /v1/owner/connections`.
//
// Both surfaces are projected server-side from one control catalog, so this
// module only consumes them; it never invents action families or routes. The
// owner bearer is read from the stored credential and sent as an Authorization
// header. It is NEVER printed: this command emits only non-secret capability
// and connection metadata.

import { OwnerAgentError } from "./errors.ts";
import { getOwnerAgentAccessToken, type OwnerAgentCredentialRecord } from "./lifecycle.ts";

type FetchFn = typeof fetch;

const TRAILING_SLASH_RE = /\/$/;

interface ControlAction {
  family?: string;
  method?: string;
  reason?: string;
  status?: string;
  url?: string;
}

interface ControlDocument {
  actions?: ControlAction[];
  entrypoint?: string;
}

interface OwnerConnection {
  connection_id?: string;
  connector_id?: string;
  connector_key?: string;
  display_name?: string;
  label_status?: string;
  status?: string;
}

interface ConnectionsListResponse {
  data?: OwnerConnection[];
}

interface DiscoverOwnerAgentControlArgs {
  fetchFn: FetchFn;
  record: OwnerAgentCredentialRecord & { resource?: string };
}

export interface OwnerAgentControlResult {
  connections: OwnerConnection[];
  control: ControlDocument;
}

/**
 * Fetch the owner-agent control capability document and the configured
 * connection listing, returning the non-secret subset each surface exposes.
 * The bearer is sent as `Authorization: Bearer` and never returned.
 */
export async function discoverOwnerAgentControl({
  fetchFn,
  record,
}: DiscoverOwnerAgentControlArgs): Promise<OwnerAgentControlResult> {
  const token = getOwnerAgentAccessToken(record);
  if (!token) {
    throw new OwnerAgentError("credential_invalid", "Stored credential is missing an access token.");
  }
  const resource = typeof record.resource === "string" ? record.resource.replace(TRAILING_SLASH_RE, "") : null;
  if (!resource) {
    throw new OwnerAgentError(
      "credential_invalid",
      "Stored credential has no resource origin; re-run `pdpp owner-agent onboard`."
    );
  }
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };

  const control = await getJson<ControlDocument>(fetchFn, `${resource}/v1/owner/control`, headers, "control_failed");
  const connectionsBody = await getJson<ConnectionsListResponse>(
    fetchFn,
    `${resource}/v1/owner/connections`,
    headers,
    "connections_failed"
  );
  const connections = Array.isArray(connectionsBody?.data) ? connectionsBody.data : [];
  return { control, connections };
}

/**
 * Format the control capability document and connection listing into a
 * non-secret, token-efficient text report. Returns the string the command
 * writes to stdout. Asserts nothing about the bearer; the caller has already
 * ensured it is never included.
 */
export function formatOwnerAgentControl({ control, connections }: OwnerAgentControlResult): string {
  const lines: string[] = [];
  lines.push("Owner-agent control capabilities (non-secret):");
  if (control.entrypoint) {
    lines.push(`  entrypoint: ${control.entrypoint}`);
  }
  lines.push("  /mcp owner bearer: rejected (use owner-bearer /v1/* REST, not /mcp)");
  lines.push("");
  lines.push("  Action families:");
  const actions = Array.isArray(control.actions) ? control.actions : [];
  for (const action of actions) {
    const family = action.family ?? "unknown";
    const status = action.status ?? "unknown";
    const route = action.method && action.url ? `${action.method} ${action.url}` : "(owner-mediated / not a route)";
    lines.push(`    - ${family} [${status}] ${route}`);
    if (action.reason) {
      lines.push(`        ${action.reason}`);
    }
  }

  lines.push("");
  lines.push(`Configured connections (${connections.length}):`);
  if (connections.length === 0) {
    lines.push("  (none yet — initiate one with the initiate_connection action above)");
  }
  for (const connection of connections) {
    const connectionId = connection.connection_id ?? "(no connection_id)";
    const connectorId = connection.connector_id ?? connection.connector_key ?? "(unknown connector)";
    lines.push(`  - ${connectionId}  connector=${connectorId}`);
    const label = formatLabel(connection);
    lines.push(`      label: ${label}`);
    if (connection.status) {
      lines.push(`      status: ${connection.status}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// An owner-meaningful label (`owner_set`) is printed as-is. A `fallback` label
// is the storage-layer placeholder (e.g. a registry URL) — surface it as
// label-needed, not as a final name, so the agent knows to rename it before
// relying on it. Never invent a label here.
function formatLabel(connection: OwnerConnection): string {
  const labelStatus = connection.label_status;
  const displayName = typeof connection.display_name === "string" ? connection.display_name : null;
  if (labelStatus === "owner_set" && displayName) {
    return `"${displayName}" (owner_set)`;
  }
  if (displayName) {
    return `label-needed (fallback: "${displayName}" — rename with rename_connection)`;
  }
  return "label-needed (no display_name — rename with rename_connection)";
}

async function getJson<T>(
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
  errorCode: string
): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: OwnerAgentError's constructor (code, message, exitCode) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new OwnerAgentError(errorCode, `Failed to fetch ${url}: ${(error as Error).message}.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new OwnerAgentError(
      "control_unauthorized",
      `Owner-agent control is not authorized (HTTP ${response.status}). The credential may be revoked or inactive; run \`pdpp owner-agent status\`.`,
      4
    );
  }
  if (!response.ok) {
    throw new OwnerAgentError(errorCode, `Failed to fetch ${url}: HTTP ${response.status}.`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    // biome-ignore lint/style/useErrorCause: OwnerAgentError's constructor (code, message, exitCode) has no cause param; the response was not valid JSON, so the parse error carries no additional information beyond that fact.
    throw new OwnerAgentError(errorCode, `Response from ${url} was not valid JSON.`);
  }
}
