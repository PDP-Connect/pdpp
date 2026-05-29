// Pure rendering and normalization helpers for the AS consent/authorize UI.
//
// Extracted from `server/index.js` per the OpenSpec change
// `split-reference-server-by-route-family`. These are the presentational and
// input-normalization functions that sit in front of the consent and authorize
// route handlers. They carry no route registration, no auth enforcement, no
// CSRF, no state writes, and no closure captures from `buildAsApp`.
//
// Covered by the consent/authorize route test suites:
//   test/hosted-mcp-oauth.test.js
//   test/hosted-mcp-picker-canonical-collapse.test.js
//   test/security-consent-risk-disclosure.test.js
//   test/security-consent-token-handoff.test.js

// ─── Hosted-UI rendering surface (injected to avoid importing .js directly) ──

export interface ConsentUiRenderer {
  escapeHtml(input: unknown): string;
  renderActionRow(
    actions: Array<{
      label: string;
      variant: string;
      method: string;
      action: string;
      hidden: Array<{ name: string; value: string }>;
    }>
  ): string;
  renderHostedDocument(opts: { title: string; providerName: string; body: string }): string;
  renderKeyValueList(items: Array<{ label: string; value?: unknown; html?: string }>): string;
  renderPageIntro(opts: { eyebrow: string; title: string; lede?: string }): string;
  renderResultState(opts: { tone: string; title: string; body: string }): string;
  renderSurface(opts: { surface?: string; ariaLabel?: string; children: string }): string;
}

// ─── Picker data capabilities (injected; async store reads) ──────────────────

export interface ConsentPickerCapabilities {
  canonicalConnectorKey(connectorId: string): string | null;
  encodeHostedMcpSelection(opts: { connectorId: string; connectionId: string | null }): string;
  encodeHostedMcpStreamSelection(opts: {
    connectorId: string;
    connectionId: string | null;
    streamName: string;
  }): string;
  getConnectorManifest(connectorId: string): Promise<ConsentPickerManifest | null>;
  hostedMcpSourceKey(opts: { connectorId: string; connectionId: string | null }): string;
  isInternalConnectorId(connectorId: string): boolean;
  listActiveBindingsForGrant(opts: { ownerSubjectId: string; connectorId: string }): Promise<ConsentPickerBinding[]>;
  listRegisteredConnectorIds(): Promise<string[]>;
  projectBindingForWire(
    conn: ConsentPickerBinding
  ): { display_name?: string | null; connection_id?: string | null } | null;
}

export interface ConsentPickerManifest {
  readonly display_name?: string | null;
  readonly name?: string | null;
  readonly streams?: Array<{ name: string; description?: string | null }> | null;
}

export interface ConsentPickerBinding {
  readonly connectorInstanceId?: string | null;
  [key: string]: unknown;
}

// ─── Picker row shape ────────────────────────────────────────────────────────

export interface HostedMcpPickerRow {
  connectionId: string | null;
  connectionName: string | null;
  connectorId: string;
  connectorTypeLabel: string;
  formValue: string;
  meta: string;
  streams: Array<{ name: string; description: string | null }>;
}

// ─── Authorization-details constants ─────────────────────────────────────────

export const HOSTED_MCP_PICKER_PURPOSE_CODE = "https://pdpp.org/purpose/personal_ai_assistant";
export const HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION =
  "Allow this MCP client to read selected personal data through PDPP.";
export const HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE = "continuous";
export const HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES: ReadonlySet<string> = new Set(["single_use", "continuous"]);

// ─── Input normalization helpers ─────────────────────────────────────────────

type OAuthError = Error & { code?: string };

/**
 * Parses the `authorization_details` query/body parameter into an array.
 * Throws a typed `invalid_request` error on malformed input.
 */
export function parseAuthorizeAuthorizationDetails(
  query: Record<string, unknown> | null | undefined
): unknown[] | null {
  const raw = query?.authorization_details;
  if (raw == null || raw === "") {
    return null;
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "object") {
    return raw as unknown[];
  }
  if (typeof raw !== "string") {
    const err: OAuthError = new Error("authorization_details must be JSON");
    err.code = "invalid_request";
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const err: OAuthError = new Error("authorization_details must decode to an array");
      err.code = "invalid_request";
      throw err;
    }
    return parsed;
  } catch (err) {
    (err as OAuthError).code = (err as OAuthError).code || "invalid_request";
    throw err;
  }
}

/**
 * Asserts that `query[name]` is a non-empty string; throws `invalid_request` otherwise.
 */
export function requireAuthorizeString(query: Record<string, unknown> | null | undefined, name: string): string {
  const value = query?.[name];
  if (typeof value !== "string" || !value.trim()) {
    const err: OAuthError = new Error(`${name} is required`);
    err.code = "invalid_request";
    throw err;
  }
  return value.trim();
}

interface ClientWithRedirectUris {
  readonly metadata?: { redirect_uris?: string[] } | null;
}

/**
 * Asserts that `redirectUri` is registered in `client.metadata.redirect_uris`.
 * Throws `invalid_request` if not.
 */
export function requireRegisteredRedirectUri(
  client: ClientWithRedirectUris | null | undefined,
  redirectUri: string
): void {
  const redirectUris =
    client?.metadata != null && Array.isArray(client.metadata.redirect_uris)
      ? (client.metadata.redirect_uris as string[])
      : [];
  if (!redirectUris.includes(redirectUri)) {
    const err: OAuthError = new Error("redirect_uri does not match a registered redirect URI");
    err.code = "invalid_request";
    throw err;
  }
}

interface PkceParams {
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
}

/**
 * Validates PKCE parameters; throws a typed OAuth error on any violation.
 */
export function validateAuthorizePkce({ responseType, codeChallenge, codeChallengeMethod }: PkceParams): void {
  if (responseType !== "code") {
    const err: OAuthError = new Error("response_type must be code");
    err.code = "unsupported_response_type";
    throw err;
  }
  if (codeChallengeMethod !== "S256") {
    const err: OAuthError = new Error("code_challenge_method must be S256");
    err.code = "invalid_request";
    throw err;
  }
  if (typeof codeChallenge !== "string" || codeChallenge.length < 43 || codeChallenge.length > 128) {
    const err: OAuthError = new Error("code_challenge must be 43-128 characters");
    err.code = "invalid_request";
    throw err;
  }
}

// ─── Authorization-details builders ──────────────────────────────────────────

/**
 * Builds a single-entry `authorization_details` array for a connector-backed
 * hosted MCP authorize shortcut (wildcard streams, continuous access).
 */
export function buildHostedMcpAuthorizationDetailsForConnector(connectorId: string): unknown[] {
  return [
    {
      type: "https://pdpp.org/data-access",
      source: { kind: "connector", id: connectorId },
      purpose_code: "https://pdpp.org/purpose/personal_ai_assistant",
      purpose_description: "Allow this MCP client to read selected personal data through PDPP.",
      access_mode: "continuous",
      streams: [{ name: "*" }],
    },
  ];
}

/**
 * Builds one source-bounded `authorization_details` entry for a hosted MCP
 * package. `streamNames` narrows the grant to those streams when provided and
 * non-empty; null preserves the wildcard default. `accessMode` is validated
 * against `HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES`; unknown values fall back
 * to `HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE` (continuous).
 */
export function buildHostedMcpAuthorizationDetailForConnector(
  connectorId: string,
  streamNames: string[] | null = null,
  accessMode: string | null = null
): {
  type: string;
  source: { kind: string; id: string };
  purpose_code: string;
  purpose_description: string;
  access_mode: string;
  streams: Array<{ name: string }>;
} {
  let streams: Array<{ name: string }>;
  if (Array.isArray(streamNames) && streamNames.length > 0) {
    streams = streamNames.map((name) => ({ name }));
  } else {
    streams = [{ name: "*" }];
  }
  const resolvedAccessMode = HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES.has(accessMode ?? "")
    ? (accessMode as string)
    : HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE;
  return {
    type: "https://pdpp.org/data-access",
    source: { kind: "connector", id: connectorId },
    purpose_code: HOSTED_MCP_PICKER_PURPOSE_CODE,
    purpose_description: HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION,
    access_mode: resolvedAccessMode,
    streams,
  };
}

// ─── Picker data builder ─────────────────────────────────────────────────────

/**
 * Fetches the hosted MCP picker rows for the given owner. One row per
 * configured connection (or one unconfigured-connector row if no connections
 * exist). Sorted by connector type label then connection name.
 */
async function buildConnectorPickerRows(
  connectorId: string,
  ownerSubjectId: string,
  caps: ConsentPickerCapabilities
): Promise<HostedMcpPickerRow[]> {
  const manifest = await caps.getConnectorManifest(connectorId).catch(() => null);
  if (!manifest) {
    return [];
  }
  const connectorLabel = manifest.display_name || manifest.name || connectorId;
  const connectorMetaToken = caps.canonicalConnectorKey(connectorId) ?? connectorId;
  const manifestStreams = Array.isArray(manifest.streams) ? manifest.streams : [];
  const streamCount = manifestStreams.length;
  const streamSummaries = manifestStreams.map((stream) => ({
    name: stream.name,
    description: typeof stream.description === "string" ? stream.description : null,
  }));
  const connections = await caps.listActiveBindingsForGrant({ ownerSubjectId, connectorId }).catch(() => []);
  if (connections.length === 0) {
    return [
      {
        formValue: caps.encodeHostedMcpSelection({ connectorId, connectionId: null }),
        connectorId,
        connectionId: null,
        connectorTypeLabel: connectorLabel,
        connectionName: null,
        meta: streamCount
          ? `${connectorMetaToken} · ${streamCount} streams · no configured connection`
          : `${connectorMetaToken} · no configured connection`,
        streams: streamSummaries,
      },
    ];
  }
  return connections.map((conn) => {
    const projected = caps.projectBindingForWire(conn);
    const displayName = projected?.display_name;
    const connectionId = projected?.connection_id || conn.connectorInstanceId || null;
    return {
      formValue: caps.encodeHostedMcpSelection({ connectorId, connectionId: connectionId ?? null }),
      connectorId,
      connectionId: connectionId ?? null,
      connectorTypeLabel: connectorLabel,
      connectionName: displayName ?? null,
      meta: streamCount ? `${connectorMetaToken} · ${streamCount} streams` : connectorMetaToken,
      streams: streamSummaries,
    };
  });
}

export async function listHostedMcpPickerRows(
  caps: ConsentPickerCapabilities,
  ownerSubjectId = "owner_local"
): Promise<HostedMcpPickerRow[]> {
  const connectorIds = await caps.listRegisteredConnectorIds();
  const rows: HostedMcpPickerRow[] = [];
  for (const connectorId of connectorIds) {
    if (caps.isInternalConnectorId(connectorId)) {
      continue;
    }
    rows.push(...(await buildConnectorPickerRows(connectorId, ownerSubjectId, caps)));
  }
  rows.sort((a, b) => {
    const typeOrder = a.connectorTypeLabel.localeCompare(b.connectorTypeLabel);
    if (typeOrder !== 0) {
      return typeOrder;
    }
    return (a.connectionName || "").localeCompare(b.connectionName || "");
  });
  return rows;
}

// ─── Consent page renderers ───────────────────────────────────────────────────

/**
 * Renders the "consent request expired / not found" page for GET /consent
 * when the request_uri no longer maps to a live pending-consent row.
 */
export function renderPendingConsentNotFoundHtml(providerName: string, ui: ConsentUiRenderer): string {
  return ui.renderHostedDocument({
    title: `${providerName} — Consent request expired`,
    providerName,
    body: [
      ui.renderPageIntro({
        eyebrow: "Data access request",
        title: "This consent request is no longer available",
      }),
      ui.renderSurface({
        surface: "human",
        ariaLabel: "Consent request expired",
        children: ui.renderResultState({
          tone: "neutral",
          title: "Link expired or already used",
          body: "This approval link has expired, was already approved or denied, or was created on a different session. Return to the app that asked for access and start the request again to get a fresh link.",
        }),
      }),
    ].join("\n"),
  });
}

interface PendingGrantRequest {
  client?: {
    client_display?: { name?: string | null } | null;
    client_id?: string | null;
  } | null;
  selection?: {
    streams?: Array<{
      name: string;
      time_range?: { since?: string | null } | null;
      fields?: string[] | null;
      view?: string | null;
      necessity?: string | null;
    }> | null;
    access_mode?: string | null;
    purpose_description?: string | null;
    purpose_code?: string | null;
    retention?: {
      max_duration?: string | null;
      on_expiry?: string | null;
    } | null;
  } | null;
  source_binding?: {
    id?: string | null;
    kind?: string | null;
  } | null;
}

interface PendingGrant {
  manifestStreamNames?: string[] | null;
  request: PendingGrantRequest;
  userCode?: string | null;
}

type StreamItem = NonNullable<NonNullable<PendingGrantRequest["selection"]>["streams"]>[number];

function buildStreamsBlock(
  requestedStreams: StreamItem[],
  sourceLabel: string,
  manifestStreamNames: string[] | null,
  ui: ConsentUiRenderer
): string {
  const isWildcard = requestedStreams.length === 1 && requestedStreams[0]?.name === "*";
  if (isWildcard) {
    const resolvedNames = manifestStreamNames && manifestStreamNames.length > 0 ? manifestStreamNames : null;
    const countSummary = resolvedNames
      ? `All streams for ${sourceLabel} (${resolvedNames.length}) are in scope.`
      : `All streams for ${sourceLabel} are in scope.`;
    const resolvedList = resolvedNames
      ? `<ul class="hosted-ui-streams">${resolvedNames
          .map((name) => `<li><span class="hosted-ui-stream-name">${ui.escapeHtml(name)}</span></li>`)
          .join("")}</ul>`
      : "";
    return `
      <div>
        <span class="pdpp-title">Streams requested</span>
        <div class="hosted-ui-warning" role="note">
          <span class="hosted-ui-warning-title">All streams</span>
          <span class="hosted-ui-warning-body">${ui.escapeHtml(countSummary)}</span>
        </div>
        ${resolvedList}
      </div>`;
  }
  const streamItems = requestedStreams
    .map((s) => {
      const fragments = [
        s.time_range ? `since ${s.time_range.since || "any"}` : null,
        s.fields ? `fields: ${s.fields.join(", ")}` : null,
        s.view ? `view: ${s.view}` : null,
        s.necessity === "optional" ? "optional" : null,
      ].filter(Boolean);
      const meta = fragments.length
        ? ` <span class="hosted-ui-stream-meta">${ui.escapeHtml(fragments.join(" · "))}</span>`
        : "";
      return `<li><span class="hosted-ui-stream-name">${ui.escapeHtml(s.name)}</span>${meta}</li>`;
    })
    .join("");
  return `
      <div>
        <span class="pdpp-title">Streams requested</span>
        <ul class="hosted-ui-streams">${streamItems}</ul>
      </div>`;
}

/**
 * Renders the active consent review page for GET /consent when a live
 * pending-consent row exists. The owner reviews streams, facts, and submits
 * approve/deny via the rendered form.
 */
export function renderPendingGrantConsentHtml(
  pending: PendingGrant,
  requestUri: string,
  csrfToken: string | null,
  csrfFieldName: string,
  providerName: string,
  ui: ConsentUiRenderer
): string {
  const request = pending.request;
  const client = request.client || {};
  const selection = request.selection || {};
  const sourceBinding = request.source_binding;
  const clientName = client.client_display?.name || client.client_id || "Client application";
  const sourceLabel = sourceBinding?.id || "this source";
  const sourceFactLabel = sourceBinding?.kind === "provider_native" ? "Provider" : "Connector";

  const requestedStreams = Array.isArray(selection.streams) ? selection.streams : [];
  const manifestStreamNames = Array.isArray(pending.manifestStreamNames) ? pending.manifestStreamNames : null;

  const streamsBlock = buildStreamsBlock(requestedStreams, sourceLabel, manifestStreamNames, ui);

  const isContinuous = selection.access_mode === "continuous";
  const hasRetentionBound = Boolean(selection.retention?.max_duration);

  let continuousBlock = "";
  if (isContinuous) {
    const continuousBody = hasRetentionBound
      ? "This is long-lived access — the client may keep reading until the grant is revoked or its retention bound is reached."
      : "This is long-lived access with no explicit expiry. The client may keep reading until you revoke the grant.";
    continuousBlock = `
      <div class="hosted-ui-warning" role="note">
        <span class="hosted-ui-warning-title">Continuous access</span>
        <span class="hosted-ui-warning-body">${ui.escapeHtml(continuousBody)}</span>
      </div>`;
  }

  const factsRaw: Array<{ label: string; value?: unknown; html?: string } | null> = [
    { label: "Requesting app", value: clientName },
    sourceBinding?.id ? { label: sourceFactLabel, value: sourceBinding.id } : null,
    {
      label: "Purpose",
      value: selection.purpose_description || selection.purpose_code,
    },
    { label: "Access mode", value: selection.access_mode },
    selection.retention
      ? {
          label: "Retention",
          value: `${selection.retention.on_expiry} after ${selection.retention.max_duration}`,
        }
      : null,
  ];
  const facts = ui.renderKeyValueList(
    factsRaw.filter((x): x is { label: string; value?: unknown; html?: string } => x !== null)
  );

  const codeBlock = pending.userCode
    ? `<div><span class="pdpp-eyebrow">Verification code</span><div class="hosted-ui-code">${ui.escapeHtml(pending.userCode)}</div></div>`
    : "";

  const csrfHidden = csrfToken ? [{ name: csrfFieldName, value: csrfToken }] : [];
  const actions = ui.renderActionRow([
    {
      label: "Allow access",
      variant: "primary",
      method: "POST",
      action: "/consent/approve",
      hidden: [...csrfHidden, { name: "request_uri", value: requestUri }],
    },
    {
      label: "Deny",
      variant: "danger",
      method: "POST",
      action: "/consent/deny",
      hidden: [...csrfHidden, { name: "request_uri", value: requestUri }],
    },
  ]);

  const body = [
    ui.renderPageIntro({
      eyebrow: "Data access request",
      title: `${clientName} wants access to your data`,
      lede: "Review what this app is asking for. Your server will only release what you allow here.",
    }),
    ui.renderSurface({
      surface: "human",
      ariaLabel: "Consent request",
      children: [codeBlock, facts, streamsBlock, continuousBlock, actions].filter(Boolean).join("\n"),
    }),
  ].join("\n");

  return ui.renderHostedDocument({
    title: `${providerName} — Consent request`,
    providerName,
    body,
  });
}

// ─── MCP picker HTML renderer ─────────────────────────────────────────────────

interface AuthorizeQueryParams {
  client_id?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  redirect_uri?: unknown;
  response_type?: unknown;
  scope?: unknown;
  state?: unknown;
  [key: string]: unknown;
}

/**
 * Renders the hosted MCP multi-source picker page for GET /oauth/authorize
 * when no `authorization_details` or `connector_id` is specified.
 */
export async function renderHostedMcpSourceSelection(
  ownerSubjectId: string,
  query: AuthorizeQueryParams | null | undefined,
  csrfToken: string,
  providerName: string,
  caps: ConsentPickerCapabilities,
  ui: ConsentUiRenderer
): Promise<string> {
  const rows = await listHostedMcpPickerRows(caps, ownerSubjectId);

  const hidden = [
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
  ]
    .map((name) => {
      const value = query?.[name];
      if (typeof value !== "string") {
        return "";
      }
      return `<input type="hidden" name="${ui.escapeHtml(name)}" value="${ui.escapeHtml(value)}" />`;
    })
    .join("\n");

  const renderRowStreams = (row: HostedMcpPickerRow): string => {
    if (!Array.isArray(row.streams) || row.streams.length === 0) {
      return '<p class="hosted-ui-option-streams-empty">This connector manifest declares no streams.</p>';
    }
    const items = row.streams
      .map((stream) => {
        const streamFormValue = caps.encodeHostedMcpStreamSelection({
          connectorId: row.connectorId,
          connectionId: row.connectionId,
          streamName: stream.name,
        });
        const description = stream.description
          ? `<span class="hosted-ui-stream-meta">${ui.escapeHtml(stream.description)}</span>`
          : "";
        return `
            <label class="hosted-ui-stream-option">
              <input type="checkbox" name="stream" value="${ui.escapeHtml(streamFormValue)}" checked />
              <span class="hosted-ui-stream-option-body">
                <span class="hosted-ui-stream-name">${ui.escapeHtml(stream.name)}</span>
                ${description}
              </span>
            </label>
          `;
      })
      .join("\n");
    return `<div class="hosted-ui-option-streams">${items}</div>`;
  };

  const options = rows.length
    ? rows
        .map(
          (row) => `
          <fieldset class="hosted-ui-option-source">
            <legend class="hosted-ui-option-source-legend">
              <label class="hosted-ui-option">
                <input type="checkbox" name="selection" value="${ui.escapeHtml(row.formValue)}" />
                <span class="hosted-ui-option-body">
                  <span class="hosted-ui-option-title">
                    <span class="hosted-ui-connector-type">${ui.escapeHtml(row.connectorTypeLabel)}</span>${row.connectionName ? `<span class="hosted-ui-connection-name">${ui.escapeHtml(row.connectionName)}</span>` : ""}
                  </span>
                  <span class="hosted-ui-option-meta">${ui.escapeHtml(row.meta)}</span>
                </span>
              </label>
            </legend>
            ${renderRowStreams(row)}
          </fieldset>
        `
        )
        .join("\n")
    : '<p class="pdpp-body">No connector manifests are registered on this reference server.</p>';

  const submit = rows.length
    ? '<button type="submit" class="hosted-ui-button" data-variant="primary">Approve selected sources</button>'
    : "";

  const riskCopy = rows.length
    ? `<p class="pdpp-body"><strong>Reference-experimental multi-source consent.</strong> Each checked source issues one independent, source-bounded PDPP grant. Within a source you can uncheck individual streams to narrow what the MCP client may read; an unchecked stream is excluded from the issued child grant. This ceremony does not encode a machine-readable retention bound on the issued grants; how long fetched results are kept is governed by the MCP client's own policy and any external agreements you have with that client.</p>`
    : "";

  const accessModeControl = rows.length
    ? `
        <fieldset class="hosted-ui-access-mode">
          <legend class="hosted-ui-access-mode-legend">Access mode</legend>
          <label class="hosted-ui-access-mode-option">
            <input type="radio" name="access_mode" value="continuous" checked />
            <span class="hosted-ui-access-mode-body">
              <span class="hosted-ui-access-mode-label">Continuous access (default)</span>
              <span class="hosted-ui-access-mode-meta">The MCP client may keep reading until you revoke this grant.</span>
            </span>
          </label>
          <label class="hosted-ui-access-mode-option">
            <input type="radio" name="access_mode" value="single_use" />
            <span class="hosted-ui-access-mode-body">
              <span class="hosted-ui-access-mode-label">Single use</span>
              <span class="hosted-ui-access-mode-meta">The MCP client may read once. The grant expires on first use.</span>
            </span>
          </label>
        </fieldset>
      `
    : "";

  return ui.renderHostedDocument({
    title: `${providerName} — Choose MCP sources`,
    providerName,
    body: [
      ui.renderPageIntro({
        eyebrow: "MCP authorization",
        title: "Choose what this MCP client can read",
        lede: "Select one or more sources to authorize for this MCP connection. The MCP endpoint remains read-only and grant-scoped.",
      }),
      ui.renderSurface({
        surface: "human",
        children: `
            ${riskCopy}
            <form method="POST" action="/oauth/authorize/mcp-package">
              <input type="hidden" name="_csrf" value="${ui.escapeHtml(csrfToken)}" />
              ${hidden}
              <div class="hosted-ui-option-group">${options}</div>
              ${accessModeControl}
              ${submit}
            </form>
          `,
      }),
    ].join("\n"),
  });
}
