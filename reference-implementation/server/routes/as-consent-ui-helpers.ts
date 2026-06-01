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

// Hosted-UI rendering surface (injected to avoid importing .js directly).

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

// Picker data capabilities (injected; async store reads).

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

// Picker row shape.

export interface HostedMcpPickerRow {
  connectionId: string | null;
  connectionName: string | null;
  connectorId: string;
  connectorTypeLabel: string;
  formValue: string;
  meta: string;
  sourceKey: string;
  streams: Array<{ name: string; description: string | null }>;
}

// Authorization-details constants.

export const HOSTED_MCP_PICKER_PURPOSE_CODE = "https://pdpp.org/purpose/personal_ai_assistant";
export const HOSTED_MCP_PICKER_PURPOSE_DESCRIPTION =
  "Allow this MCP client to read selected personal data through PDPP.";
export const HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE = "continuous";
export const HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES: ReadonlySet<string> = new Set(["single_use", "continuous"]);

// Input normalization helpers.

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

// Authorization-details builders.

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
 *
 * `connectionId`, when a non-empty string, pins every stream entry to that
 * connection by stamping `connection_id` onto it. This is the enforcement
 * lever: `resolveGrantSelection` copies `streams[].connection_id` onto the
 * issued child grant, and the read-path binding resolver narrows fan-in to the
 * named connection. Wildcard stream selections are pinned identically — the
 * runtime narrows the binding to the connection, then expands streams under
 * it. Callers MUST only pass a `connectionId` the picker presented and
 * validated as active, and MUST omit it when the surface did not present a
 * specific-connection choice (single-connection or unconfigured connector), so
 * fan-in semantics and existing grants are preserved.
 */
export function buildHostedMcpAuthorizationDetailForConnector(
  connectorId: string,
  streamNames: string[] | null = null,
  accessMode: string | null = null,
  connectionId: string | null = null
): {
  type: string;
  source: { kind: string; id: string };
  purpose_code: string;
  purpose_description: string;
  access_mode: string;
  streams: Array<{ name: string; connection_id?: string }>;
} {
  const pinnedConnectionId = typeof connectionId === "string" && connectionId.trim() ? connectionId.trim() : null;
  const withPin = (name: string): { name: string; connection_id?: string } =>
    pinnedConnectionId ? { name, connection_id: pinnedConnectionId } : { name };
  let streams: Array<{ name: string; connection_id?: string }>;
  if (Array.isArray(streamNames) && streamNames.length > 0) {
    streams = streamNames.map((name) => withPin(name));
  } else {
    streams = [withPin("*")];
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

// Picker data builder.

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
  const connectorMetaToken = ownerFacingConnectorKey(connectorId, caps);
  const connectorLabel = ownerFacingConnectorLabel(manifest.display_name || manifest.name, connectorMetaToken);
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
        meta: buildPickerRowMeta({
          connectorLabel,
          connectorKey: connectorMetaToken,
          streamCount,
        }),
        sourceKey: caps.hostedMcpSourceKey({ connectorId, connectionId: null }),
        streams: streamSummaries,
      },
    ];
  }
  return connections.map((conn) => {
    const projected = caps.projectBindingForWire(conn);
    const displayName = projected?.display_name;
    const connectionId = projected?.connection_id || conn.connectorInstanceId || null;
    const connectionName = ownerFacingConnectionName(displayName, {
      connectorId,
      connectorLabel,
      connectorKey: connectorMetaToken,
    });
    return {
      formValue: caps.encodeHostedMcpSelection({ connectorId, connectionId: connectionId ?? null }),
      connectorId,
      connectionId: connectionId ?? null,
      connectorTypeLabel: connectorLabel,
      connectionName,
      meta: buildPickerRowMeta({ connectorLabel, connectorKey: connectorMetaToken, streamCount }),
      sourceKey: caps.hostedMcpSourceKey({ connectorId, connectionId: connectionId ?? null }),
      streams: streamSummaries,
    };
  });
}

function ownerFacingConnectorKey(connectorId: string, caps: ConsentPickerCapabilities): string {
  const canonical = caps.canonicalConnectorKey(connectorId);
  if (canonical) {
    return canonical;
  }
  try {
    const url = new URL(connectorId);
    const lastPathToken = url.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1);
    return lastPathToken || url.hostname || connectorId;
  } catch {
    return connectorId;
  }
}

function ownerFacingConnectorLabel(label: string | null | undefined, fallbackKey: string): string {
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (!trimmed) {
    return fallbackKey;
  }
  try {
    const url = new URL(trimmed);
    return (
      url.pathname
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean)
        .at(-1) || fallbackKey
    );
  } catch {
    return trimmed;
  }
}

function ownerFacingConnectionName(
  displayName: string | null | undefined,
  { connectorId, connectorLabel, connectorKey }: { connectorId: string; connectorLabel: string; connectorKey: string }
): string | null {
  const trimmed = typeof displayName === "string" ? displayName.trim() : "";
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeConnectorLabel(trimmed);
  const redundantLabels = new Set(
    [connectorId, connectorLabel, connectorKey, ownerFacingConnectorLabel(connectorId, connectorKey)]
      .filter(Boolean)
      .map((value) => normalizeConnectorLabel(value))
  );
  if (redundantLabels.has(normalized) || trimmed.startsWith("cin_")) {
    return null;
  }
  try {
    new URL(trimmed);
    return null;
  } catch {
    return trimmed;
  }
}

function normalizeConnectorLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");
}

function buildPickerRowMeta({
  connectorLabel,
  connectorKey,
  streamCount,
  suffix,
}: {
  connectorLabel: string;
  connectorKey: string;
  streamCount: number;
  suffix?: string;
}): string {
  const parts: string[] = [];
  parts.push(streamCount === 1 ? "1 stream available" : `${streamCount} streams available`);
  // Only surface the technical connector key when the owner-facing label does
  // not already carry it, so we never repeat the same identity twice.
  if (normalizeConnectorLabel(connectorLabel) !== normalizeConnectorLabel(connectorKey)) {
    parts.push(connectorKey);
  }
  if (suffix) {
    parts.push(suffix);
  }
  return parts.join(" · ");
}

// A short, owner-readable preview of the streams a collapsed source holds, so
// the owner can tell a one-stream grant is possible without opening the row.
// Names are the manifest stream names; we cap the list to keep the summary
// scannable and append a "+N more" tail when truncated.
function buildStreamPreview(streams: Array<{ name: string; description: string | null }> | null | undefined): string {
  if (!Array.isArray(streams) || streams.length === 0) {
    return "";
  }
  const names = streams.map((stream) => stream.name).filter((name) => typeof name === "string" && name);
  if (names.length === 0) {
    return "";
  }
  const MAX_SHOWN = 4;
  if (names.length <= MAX_SHOWN) {
    return names.join(", ");
  }
  const shown = names.slice(0, MAX_SHOWN);
  const remaining = names.length - shown.length;
  return `${shown.join(", ")} +${remaining} more`;
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

// Consent page renderers.

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

export interface PendingGrantRequest {
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

export interface PendingGrant {
  approveAllGate?: { approve_all_suppressed: boolean; suppression_reasons: string[] } | null;
  batch?: boolean;
  cards?: PendingConsentCard[];
  cumulativeRisk?: PendingConsentCumulativeRisk | null;
  manifestStreamNames?: string[] | null;
  overCapSources?: Array<{ id?: string | null; kind?: string | null } | null> | null;
  overSoftCap?: boolean;
  request: PendingGrantRequest;
  softCap?: number;
  softCapWarning?: boolean;
  userCode?: string | null;
}

type StreamItem = NonNullable<NonNullable<PendingGrantRequest["selection"]>["streams"]>[number];

interface PendingConsentCard {
  access_mode?: string | null;
  index: number;
  manifestStreamNames?: string[] | null;
  purpose_code?: string | null;
  resolvedStreams?: StreamItem[] | null;
  retention?: { max_duration?: string | null; on_expiry?: string | null } | null;
  sensitivity?: "standard" | "sensitive" | string | null;
  source?: { id?: string | null; kind?: string | null } | null;
}

interface PendingConsentCumulativeRisk {
  continuous_access_count?: number;
  no_field_projection_count?: number;
  no_time_bound_count?: number;
  sensitive_source_count?: number;
  source_count?: number;
  total_stream_count?: number;
}

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

function buildBatchRiskHeader(risk: PendingConsentCumulativeRisk | null | undefined, ui: ConsentUiRenderer): string {
  const items = [
    { label: "Sources in this request", value: risk?.source_count ?? 0 },
    { label: "Sensitive sources", value: risk?.sensitive_source_count ?? 0 },
    { label: "Continuous-access sources", value: risk?.continuous_access_count ?? 0 },
    { label: "Sources with no time bound", value: risk?.no_time_bound_count ?? 0 },
    { label: "Sources without field projection", value: risk?.no_field_projection_count ?? 0 },
    { label: "Total streams", value: risk?.total_stream_count ?? 0 },
  ];
  return ui.renderSurface({
    surface: "human",
    ariaLabel: "Cumulative batch risk",
    children: `<span class="pdpp-eyebrow">Reference-experimental batch consent</span>
<h2 class="pdpp-heading">Cumulative access across this request</h2>
${ui.renderKeyValueList(items)}`,
  });
}

function buildBatchSourceCards(cards: PendingConsentCard[], ui: ConsentUiRenderer): string {
  return cards
    .map((card) => {
      const sourceLabel = card.source?.id || `source ${card.index + 1}`;
      const streams = Array.isArray(card.resolvedStreams) ? card.resolvedStreams : [];
      const streamsBlock = buildStreamsBlock(streams, sourceLabel, card.manifestStreamNames ?? null, ui);
      const facts = ui.renderKeyValueList([
        { label: "Source", value: sourceLabel },
        { label: "Access mode", value: card.access_mode || "unspecified" },
        { label: "Sensitivity", value: card.sensitivity || "standard" },
        { label: "Purpose", value: card.purpose_code || "unspecified" },
      ]);
      return ui.renderSurface({
        surface: "human",
        ariaLabel: `Source ${card.index + 1}`,
        children: `<h3 class="pdpp-title">${ui.escapeHtml(sourceLabel)}</h3>${facts}${streamsBlock}`,
      });
    })
    .join("\n");
}

const APPROVE_ALL_SUPPRESSION_LABELS: Record<string, string> = {
  continuous_all_streams: "a source requests continuous access to all of its streams",
  sensitive_no_time_bound: "a sensitive source has no time bound",
  three_or_more_sensitive_sources: "three or more sources are sensitive",
};

function buildPerSourceConfirmForm(
  cards: PendingConsentCard[],
  requestUri: string,
  csrfToken: string | null,
  csrfFieldName: string,
  ui: ConsentUiRenderer
): string {
  const csrfInput = csrfToken
    ? `<input type="hidden" name="${ui.escapeHtml(csrfFieldName)}" value="${ui.escapeHtml(csrfToken)}" />`
    : "";
  const checkboxes = cards
    .map((card) => {
      const sourceLabel = card.source?.id || `source ${card.index + 1}`;
      return `<label class="hosted-ui-source-toggle"><input type="checkbox" name="approved_source_indexes" value="${ui.escapeHtml(
        String(card.index)
      )}" checked /> ${ui.escapeHtml(sourceLabel)}</label>`;
    })
    .join("\n");
  return `<form class="hosted-ui-form" method="POST" action="/consent/approve" aria-label="Confirm each source">
${csrfInput}<input type="hidden" name="request_uri" value="${ui.escapeHtml(requestUri)}" />
<div class="hosted-ui-source-toggles"><span class="pdpp-title">Confirm each source</span>${checkboxes}</div>
<button type="submit" class="hosted-ui-button" data-variant="primary">Confirm selected sources</button>
</form>`;
}

function buildApproveAllForm(
  cards: PendingConsentCard[],
  requestUri: string,
  csrfToken: string | null,
  csrfFieldName: string,
  ui: ConsentUiRenderer
): string {
  const csrfInput = csrfToken
    ? `<input type="hidden" name="${ui.escapeHtml(csrfFieldName)}" value="${ui.escapeHtml(csrfToken)}" />`
    : "";
  const sourceList = cards.map((card) => ui.escapeHtml(card.source?.id || `source ${card.index + 1}`)).join(", ");
  return `<form class="hosted-ui-form" method="POST" action="/consent/approve" aria-label="Allow all sources">
${csrfInput}<input type="hidden" name="request_uri" value="${ui.escapeHtml(requestUri)}" />
<label class="hosted-ui-source-toggle"><input type="checkbox" name="confirm_approve_all" value="1" required /> I confirm allowing all ${cards.length} sources: ${sourceList}</label>
<button type="submit" class="hosted-ui-button" data-variant="default">Allow all sources</button>
</form>`;
}

function renderBatchConsentHtml(
  pending: PendingGrant,
  requestUri: string,
  csrfToken: string | null,
  csrfFieldName: string,
  providerName: string,
  ui: ConsentUiRenderer
): string {
  const request = pending.request;
  const client = request.client || {};
  const clientName = client.client_display?.name || client.client_id || "Client application";
  const cards = Array.isArray(pending.cards) ? pending.cards : [];
  const csrfHidden = csrfToken ? [{ name: csrfFieldName, value: csrfToken }] : [];
  const approveAllSuppressed = pending.approveAllGate?.approve_all_suppressed === true;
  const suppressionReasons = Array.isArray(pending.approveAllGate?.suppression_reasons)
    ? pending.approveAllGate.suppression_reasons
    : [];
  const suppressionNote = approveAllSuppressed
    ? `<div class="hosted-ui-warning" role="note"><span class="hosted-ui-warning-title">Per-source confirmation required</span><span class="hosted-ui-warning-body">${ui.escapeHtml(
        `This request is too broad for a single approve-all (${suppressionReasons
          .map((reason) => APPROVE_ALL_SUPPRESSION_LABELS[reason] || reason)
          .join("; ")}). Confirm each source individually below.`
      )}</span></div>`
    : "";
  const broadWarning = pending.softCapWarning
    ? `<div class="hosted-ui-warning" role="note"><span class="hosted-ui-warning-title">Broad setup</span><span class="hosted-ui-warning-body">This request is at or above the reference warning threshold.</span></div>`
    : "";
  const overCapSourceLabels = Array.isArray(pending.overCapSources)
    ? pending.overCapSources.map((source) => source?.id || "unnamed source")
    : [];
  const overCapWarning = pending.overSoftCap
    ? `<div class="hosted-ui-warning" role="note"><span class="hosted-ui-warning-title">Over the soft cap</span><span class="hosted-ui-warning-body">${ui.escapeHtml(
        `This request stages ${cards.length} sources, above the reference soft cap of ${
          pending.softCap ?? cards.length
        }. No sources were dropped; review the over-cap sources individually: ${
          overCapSourceLabels.length > 0 ? overCapSourceLabels.join(", ") : "unnamed sources"
        }.`
      )}</span></div>`
    : "";
  const denyForm = ui.renderActionRow([
    {
      label: "Deny",
      variant: "danger",
      method: "POST",
      action: "/consent/deny",
      hidden: [...csrfHidden, { name: "request_uri", value: requestUri }],
    },
  ]);
  const actions = [
    suppressionNote,
    buildPerSourceConfirmForm(cards, requestUri, csrfToken, csrfFieldName, ui),
    approveAllSuppressed ? "" : buildApproveAllForm(cards, requestUri, csrfToken, csrfFieldName, ui),
    denyForm,
  ]
    .filter(Boolean)
    .join("\n");

  const body = [
    ui.renderPageIntro({
      eyebrow: "Data access request",
      title: `${clientName} wants access to several sources`,
      lede: "Review each source. Your server will only issue grants for sources you confirm.",
    }),
    overCapWarning,
    broadWarning,
    buildBatchRiskHeader(pending.cumulativeRisk, ui),
    buildBatchSourceCards(cards, ui),
    ui.renderSurface({ surface: "human", ariaLabel: "Consent actions", children: actions }),
  ]
    .filter(Boolean)
    .join("\n");

  return ui.renderHostedDocument({
    title: `${providerName} — Batch consent request`,
    providerName,
    body,
  });
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
  if (pending.batch) {
    return renderBatchConsentHtml(pending, requestUri, csrfToken, csrfFieldName, providerName, ui);
  }

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

// MCP picker HTML renderer.

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
  ui: ConsentUiRenderer,
  opts: { validationError?: string | null } = {}
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
      return '<p class="hosted-ui-option-streams-empty">This source does not list any grantable streams yet.</p>';
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
              <input type="checkbox" name="stream" value="${ui.escapeHtml(streamFormValue)}" data-hosted-mcp-stream-checkbox data-source-key="${ui.escapeHtml(row.sourceKey)}" />
              <span class="hosted-ui-stream-option-body">
                <span class="hosted-ui-stream-name">${ui.escapeHtml(stream.name)}</span>
                ${description}
              </span>
            </label>
          `;
      })
      .join("\n");
    return `<div class="hosted-ui-option-streams" data-hosted-mcp-streams data-streams-enabled="true" aria-disabled="false">${items}</div>`;
  };

  const options = rows.length
    ? rows
        .map((row, index) => {
          const summaryId = `hosted-mcp-source-summary-${index}`;
          const sourceKey = ui.escapeHtml(row.sourceKey);
          const sourceDisabled = !Array.isArray(row.streams) || row.streams.length === 0;
          const sourceDisabledAttrs = sourceDisabled ? ' disabled aria-disabled="true"' : "";
          const streamPreview = buildStreamPreview(row.streams);
          const previewBlock = streamPreview
            ? `<span class="hosted-ui-option-preview">${ui.escapeHtml(streamPreview)}</span>`
            : "";
          return `
          <details class="hosted-ui-option-source" data-hosted-mcp-source data-source-key="${sourceKey}" data-source-selected="false">
            <summary class="hosted-ui-option-source-legend hosted-ui-option-summary">
              <label class="hosted-ui-option">
                <input type="checkbox" name="selection" value="${ui.escapeHtml(row.formValue)}" data-hosted-mcp-source-checkbox data-source-selection-mode="streams" data-source-key="${sourceKey}" aria-describedby="${summaryId}"${sourceDisabledAttrs} />
                <span class="hosted-ui-option-body">
                  <span class="hosted-ui-option-title">
                    <span class="hosted-ui-connector-type">${ui.escapeHtml(row.connectorTypeLabel)}</span>${row.connectionName ? `<span class="hosted-ui-connection-name">${ui.escapeHtml(row.connectionName)}</span>` : ""}
                  </span>
                  ${previewBlock}
                  <span class="hosted-ui-option-meta" id="${summaryId}">${ui.escapeHtml(row.meta)}</span>
                </span>
              </label>
            </summary>
            <div class="hosted-ui-option-stream-controls">
              <p class="hosted-ui-option-streams-help">Each stream you check is granted on its own. Use the buttons below to share or clear this whole source at once.</p>
              <div class="hosted-ui-actions hosted-ui-stream-actions" aria-label="Stream controls for ${ui.escapeHtml(row.connectorTypeLabel)}">
                <button type="button" class="hosted-ui-button" data-hosted-mcp-select-streams>Select every stream</button>
                <button type="button" class="hosted-ui-button" data-hosted-mcp-clear-streams>Clear this source</button>
              </div>
            </div>
            ${renderRowStreams(row)}
          </details>
        `;
        })
        .join("\n")
    : '<p class="pdpp-body">No sources are available on this server yet.</p>';

  const submit = rows.length
    ? '<button type="submit" class="hosted-ui-button" data-variant="primary">Approve selected data</button>'
    : "";

  const riskCopy = rows.length
    ? `<p class="pdpp-body"><strong>Share only what this app needs.</strong> A source is its streams: check the streams you want to share, and that source is included. Check one stream to share just that stream, or use the per-source buttons to share all of it. A source with no streams checked is not shared, and you can revoke any source you approve here later.</p>
            <p class="pdpp-body hosted-ui-retention-note">This page does not set a time limit on data the app keeps after reading it from your server. Review the app's own terms before approving.</p>`
    : "";

  const validationError = typeof opts.validationError === "string" ? opts.validationError.trim() : "";
  const validationBanner = rows.length
    ? `<div class="hosted-ui-error hosted-ui-picker-error" role="alert" data-hosted-mcp-picker-error data-default-message="Select at least one source and one stream inside each selected source before approving."${validationError ? "" : " hidden"}>${ui.escapeHtml(validationError)}</div>`
    : "";

  const bulkControls = rows.length
    ? `
        <div class="hosted-ui-actions hosted-ui-picker-toolbar" aria-label="Source bulk controls">
          <button type="button" class="hosted-ui-button" data-hosted-mcp-select-sources>Select all</button>
          <button type="button" class="hosted-ui-button" data-hosted-mcp-clear-sources>Clear all</button>
          <span class="hosted-ui-toolbar-divider" aria-hidden="true"></span>
          <button type="button" class="hosted-ui-button" data-hosted-mcp-expand-all>Expand all</button>
          <button type="button" class="hosted-ui-button" data-hosted-mcp-collapse-all>Collapse all</button>
        </div>
      `
    : "";

  const accessModeControl = rows.length
    ? `
        <fieldset class="hosted-ui-access-mode">
          <legend class="hosted-ui-access-mode-legend">How long access lasts</legend>
          <label class="hosted-ui-access-mode-option">
            <input type="radio" name="access_mode" value="continuous" checked />
            <span class="hosted-ui-access-mode-body">
              <span class="hosted-ui-access-mode-label">Keep access until I revoke it</span>
              <span class="hosted-ui-access-mode-meta">Best for apps that need to stay up to date.</span>
            </span>
          </label>
          <label class="hosted-ui-access-mode-option">
            <input type="radio" name="access_mode" value="single_use" />
            <span class="hosted-ui-access-mode-body">
              <span class="hosted-ui-access-mode-label">Allow one read only</span>
              <span class="hosted-ui-access-mode-meta">Best for a one-time check or export.</span>
            </span>
          </label>
        </fieldset>
      `
    : "";

  const pickerBehaviorStyles = rows.length
    ? `<style>
.hosted-ui-option-summary {
  list-style: none;
}
.hosted-ui-option-summary::-webkit-details-marker {
  display: none;
}
.hosted-ui-option-summary::after {
  content: "Choose streams";
  display: block;
  padding: 0 0.25rem 0.5rem 2rem;
  color: var(--muted-foreground);
  font-size: 0.75rem;
}
.hosted-ui-option-source[open] > .hosted-ui-option-summary::after {
  content: "Hide streams";
}
.hosted-ui-toolbar-divider {
  width: 1px;
  align-self: stretch;
  background: var(--border);
  margin: 0.125rem 0.25rem;
}
.hosted-ui-option-preview {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.45;
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
.hosted-ui-picker-toolbar,
.hosted-ui-stream-actions {
  margin: 0.75rem 0;
}
.hosted-ui-picker-toolbar .hosted-ui-button,
.hosted-ui-stream-actions .hosted-ui-button {
  padding: 0.425rem 0.75rem;
  font-size: 0.8125rem;
}
.hosted-ui-option-stream-controls {
  padding: 0 0.25rem 0 1.75rem;
}
.hosted-ui-option-streams-help {
  margin: 0.25rem 0 0.5rem;
  color: var(--muted-foreground);
  font-size: 0.8125rem;
}
.hosted-ui-picker-error {
  margin: 0 0 1rem;
}
</style>`
    : "";

  const pickerBehaviorScript = rows.length
    ? `<script>
(() => {
  const form = document.querySelector("[data-hosted-mcp-picker-form]");
  if (!form) return;
  const error = form.querySelector("[data-hosted-mcp-picker-error]");
  const sources = Array.from(form.querySelectorAll("[data-hosted-mcp-source]"));
  const sourceBoxes = () => Array.from(form.querySelectorAll("[data-hosted-mcp-source-checkbox]"));
  const streamsFor = (source) => Array.from(source.querySelectorAll("[data-hosted-mcp-stream-checkbox]"));
  const setError = (message) => {
    if (!error) return;
    if (message) {
      error.textContent = message;
      error.hidden = false;
    } else {
      error.textContent = "";
      error.hidden = true;
    }
  };
  const syncSource = (source) => {
    const sourceBox = source.querySelector("[data-hosted-mcp-source-checkbox]");
    if (!sourceBox) return;
    const streamBoxes = streamsFor(source);
    const checkedCount = streamBoxes.filter((streamBox) => streamBox.checked).length;
    const selected = checkedCount > 0;
    const partiallySelected = selected && checkedCount < streamBoxes.length;
    sourceBox.checked = selected;
    sourceBox.indeterminate = partiallySelected;
    sourceBox.setAttribute("aria-checked", partiallySelected ? "mixed" : selected ? "true" : "false");
    source.dataset.sourceSelected = selected ? "true" : "false";
    const streamGroup = source.querySelector("[data-hosted-mcp-streams]");
    if (streamGroup) {
      streamGroup.dataset.streamsEnabled = "true";
      streamGroup.setAttribute("aria-disabled", "false");
    }
    for (const streamBox of streamBoxes) {
      streamBox.disabled = false;
    }
    if (selected) {
      source.open = true;
    }
  };
  for (const source of sources) {
    const sourceBox = source.querySelector("[data-hosted-mcp-source-checkbox]");
    if (!sourceBox) continue;
    sourceBox.addEventListener("change", () => {
      const streamBoxes = streamsFor(source);
      const selectAll = sourceBox.checked;
      for (const streamBox of streamBoxes) {
        streamBox.checked = selectAll;
      }
      syncSource(source);
      setError("");
    });
    for (const streamBox of streamsFor(source)) {
      streamBox.addEventListener("change", () => {
        syncSource(source);
        setError("");
      });
    }
    source.querySelector("[data-hosted-mcp-select-streams]")?.addEventListener("click", () => {
      for (const streamBox of streamsFor(source)) {
        streamBox.checked = true;
      }
      syncSource(source);
      setError("");
    });
    source.querySelector("[data-hosted-mcp-clear-streams]")?.addEventListener("click", () => {
      for (const streamBox of streamsFor(source)) {
        streamBox.checked = false;
      }
      syncSource(source);
      source.open = false;
      setError("");
    });
  }
  form.querySelector("[data-hosted-mcp-select-sources]")?.addEventListener("click", () => {
    for (const source of sources) {
      const sourceBox = source.querySelector("[data-hosted-mcp-source-checkbox]");
      if (sourceBox?.disabled) continue;
      for (const streamBox of streamsFor(source)) {
        streamBox.checked = true;
      }
      syncSource(source);
    }
    setError("");
  });
  form.querySelector("[data-hosted-mcp-clear-sources]")?.addEventListener("click", () => {
    for (const source of sources) {
      for (const streamBox of streamsFor(source)) {
        streamBox.checked = false;
      }
      syncSource(source);
    }
    setError("");
  });
  form.querySelector("[data-hosted-mcp-expand-all]")?.addEventListener("click", () => {
    for (const source of sources) {
      source.open = true;
    }
  });
  form.querySelector("[data-hosted-mcp-collapse-all]")?.addEventListener("click", () => {
    for (const source of sources) {
      source.open = false;
    }
  });
  form.addEventListener("submit", (event) => {
    for (const source of sources) {
      syncSource(source);
    }
    if (!sourceBoxes().some((sourceBox) => sourceBox.checked)) {
      event.preventDefault();
      setError(error?.dataset.defaultMessage || "Select at least one source before approving.");
      return;
    }
    const incomplete = sources.find((source) => {
      const sourceBox = source.querySelector("[data-hosted-mcp-source-checkbox]");
      const streamBoxes = streamsFor(source);
      return sourceBox?.checked && streamBoxes.length > 0 && !streamBoxes.some((streamBox) => streamBox.checked);
    });
    if (incomplete) {
      event.preventDefault();
      incomplete.open = true;
      setError("Choose at least one stream inside each selected source, or clear that source.");
    }
  });
  for (const source of sources) {
    syncSource(source);
  }
})();
</script>`
    : "";

  return ui.renderHostedDocument({
    title: `${providerName} — Choose data sources`,
    providerName,
    body: [
      ui.renderPageIntro({
        eyebrow: "Data access request",
        title: "Choose what this app can read",
        lede: "Pick the streams this app may read. Anything you leave unchecked stays private.",
      }),
      ui.renderSurface({
        surface: "human",
        children: `
            ${pickerBehaviorStyles}
            ${riskCopy}
            <form method="POST" action="/oauth/authorize/mcp-package" data-hosted-mcp-picker-form>
              <input type="hidden" name="_csrf" value="${ui.escapeHtml(csrfToken)}" />
              ${hidden}
              ${validationBanner}
              ${bulkControls}
              <div class="hosted-ui-option-group">${options}</div>
              ${accessModeControl}
              ${submit}
            </form>
            ${pickerBehaviorScript}
          `,
      }),
    ].join("\n"),
  });
}
