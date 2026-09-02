// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the AS OAuth authorize route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family`.
//
// Covers:
//   GET  /oauth/authorize             — initiate OAuth flow; shows hosted MCP
//                                       picker for multi-source grants or
//                                       redirects to consent for single-source
//   POST /oauth/authorize/mcp-package — hosted MCP picker submission: builds a
//                                       package grant and issues an auth code
//
// Auth posture:
//   Both routes — ownerAuth.requireOwnerSession (owner-cookie enforcement).
//   POST /oauth/authorize/mcp-package additionally requires ownerAuth.requireCsrf.
//
// Canonical operations delegated to injected capabilities:
//   consentStore.initiateGrant     — initiate a pending-consent device-code flow
//   createHostedMcpGrantPackage    — create a package grant for multi-source picker
//   stageOAuthAuthorizationCodeRequest — stage the PKCE authorization code
//   issueOAuthAuthorizationCodeForPackageDeviceCode — issue code for package

import { randomBytes } from "node:crypto";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";
import type { ConsentPickerBinding, ConsentPickerCapabilities, ConsentUiRenderer } from "./as-consent-ui-helpers.ts";
import {
  ActiveBindingLookupError,
  buildHostedMcpAuthorizationDetailForConnector,
  buildHostedMcpAuthorizationDetailsForConnector,
  HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE,
  HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES,
  parseAuthorizeAuthorizationDetails,
  renderHostedMcpSourceSelection,
  requireAuthorizeString,
  requireRegisteredRedirectUri,
  resolveHostedMcpSourceDescriptor,
  validateAuthorizePkce,
} from "./as-consent-ui-helpers.ts";

// ─── Minimal structural types ────────────────────────────────────────────────

interface RouteRequest {
  readonly body: Record<string, unknown> | null | undefined;
  ownerAuth?: { subjectId?: string };
  readonly query: Record<string, unknown>;
}

interface RouteResponse {
  redirect: (status: number, url: string) => unknown;
  send: (body: string) => unknown;
  status: (status: number) => RouteResponse;
}

interface ClientResolutionCorrelation {
  requestId: string | null;
  traceId: string | null;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<unknown>;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler | MiddlewareHandler>[]) => AppLike;
  post: (path: string, ...args: RouteArg<RouteHandler | MiddlewareHandler>[]) => AppLike;
}

const OAUTH_AUTHORIZATION_ERROR_CODES: Readonly<Record<string, string>> = {
  "source.authorization_details_invalid": "invalid_authorization_details",
  undefined: "invalid_request",
};

// Shape expected by requireRegisteredRedirectUri (mirrors as-consent-ui-helpers.ts internal type).
interface OAuthClient {
  readonly metadata?: { redirect_uris?: string[] } | null;
}

interface ConsentStoreOutput {
  authorization_url: string;
  expires_in?: number;
  request_uri: string;
}

interface ConsentStore {
  initiateGrant: (
    params: { client_id: string; authorization_details: unknown },
    opts: { baseUrl: string; nativeManifest: unknown }
  ) => Promise<ConsentStoreOutput>;
  parseRequestUri: (requestUri: string) => string | null;
}

interface PackageGrantResult {
  package_id: string;
  token: string;
}

interface IssuedCode {
  code: string;
  redirect_uri: string;
  state?: string | null;
}

// Hosted-MCP selection parsers live in hosted-mcp-selection.js. They are not
// part of ConsentPickerCapabilities (that interface covers picker-page rendering
// capabilities), so they are injected separately.
interface HostedMcpSelectionParsers {
  parseHostedMcpSelections: (raw: unknown) => Array<{ connectorId: string; connectionId: string | null }>;
  parseHostedMcpStreamSelections: (raw: unknown) => {
    bySource: Map<string, Set<string>>;
  };
}

// ─── Injected capabilities ───────────────────────────────────────────────────

export interface MountAsAuthorizeContext {
  /** Explicit AS public URL override, or null. */
  asPublicUrl: string | null;
  /** The hosted MCP source picker capabilities (rendering + registry lookups). */
  consentPickerCaps: ConsentPickerCapabilities;
  /** Consent store for pending-grant lifecycle. */
  consentStore: ConsentStore;
  /** The consent/authorize UI rendering helpers. */
  consentUi: ConsentUiRenderer;
  /** Creates a hosted MCP multi-source package grant. */
  createHostedMcpGrantPackage: (args: {
    authorizationDetails: unknown[];
    clientId: string;
    connectionIds: Array<string | null>;
    opts: Record<string, never>;
    sourceMetadata: Array<{ connector_display_name: string; display_name: string | null }>;
    storageBindings: Array<{ connector_id: string }>;
    subjectId: string;
  }) => Promise<PackageGrantResult>;
  /** Reads the owner CSRF token from session, setting a new one if absent. */
  ensureCsrfToken: (req: RouteRequest, res: RouteResponse) => string;
  /** Reads the Request-Id set by AS middleware for causal transport-event correlation. */
  ensureRequestId: (res: RouteResponse) => string;
  /** Retrieves a registered OAuth client by client_id, or null if not found. */
  getRegisteredClient: (clientId: string, correlation: ClientResolutionCorrelation) => Promise<OAuthClient | null>;
  /** Whether to ignore ambient PUBLIC_URL env vars when resolving the base URL. */
  ignoreAmbientPublicUrls: boolean;
  /** Issues an OAuth authorization code bound to a package device-code. */
  issueOAuthAuthorizationCodeForPackageDeviceCode: (
    deviceCode: string,
    args: { packageId: string; token: string }
  ) => Promise<IssuedCode | null>;
  /** Resolved native manifest for this server instance, or null. */
  nativeManifest: unknown;
  /**
   * Writes an OAuth error envelope and returns. `extras` is merged into the
   * top-level envelope so a resolvable client/scope condition (e.g. a stream
   * with no eligible connector instance) can name the affected stream(s) in
   * structured form, not only inside `message` prose.
   */
  oauthError: (
    res: unknown,
    status: number,
    code: string,
    message: string,
    extras?: Readonly<Record<string, unknown>>
  ) => unknown;
  /** Provider name for picker HTML rendering. */
  providerName: string;
  /** CSRF enforcement middleware. */
  requireCsrf: MiddlewareHandler;
  /** Owner-session enforcement middleware. */
  requireOwnerSession: MiddlewareHandler;
  /** Resolves the public base URL from the request and any explicit override. */
  resolvePublicUrl: (req: RouteRequest, explicitBaseUrl: string | null) => string;
  /** Hosted-MCP selection parsers (from hosted-mcp-selection.js). */
  selectionParsers: HostedMcpSelectionParsers;
  /** Stages an OAuth authorization code request (PKCE device-code shell). */
  stageOAuthAuthorizationCodeRequest: (args: {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    deviceCode: string;
    expiresInSeconds: number;
    redirectUri: string;
    state: string | null;
  }) => Promise<void>;
}

// ─── Per-source entry builder (extracted to reduce POST handler complexity) ──

interface SourceEntryAccumulator {
  authorizationDetails: unknown[];
  connectionIds: Array<string | null>;
  seenChildKeys: Set<string>;
  sourceMetadata: Array<{ connector_display_name: string; display_name: string | null }>;
  sourcesWithEmptyStreams: Array<{ connectorId: string; connectionId: string | null; connectorLabel: string }>;
  storageBindings: Array<{ connector_id: string }>;
}

// Decides whether the owner's selected connection should be pinned as an
// enforceable `grant.streams[].connection_id` constraint on the issued child
// grant, versus omitted to preserve fan-in.
//
// Pin iff the owner selected a specific connection AND the connector has more
// than one active binding — i.e. the picker presented sibling connections and
// the owner disambiguated among them. When the connector has exactly one active
// binding (or none), "selecting" it is not a disambiguating choice: fan-in over
// a set of one already resolves to that connection, auto-select covers it, and
// stamping a `connection_id` would only add a brittle stored id that pressures
// existing grants without changing what the read returns. This keeps
// single-connection deployments and existing grants byte-for-byte unchanged.
//
// Pure and side-effect free so the pin policy is unit-testable in isolation.
export function shouldPinSelectedConnection(
  connectionId: string | null | undefined,
  activeBindingCount: number
): boolean {
  if (typeof connectionId !== "string" || !connectionId.trim()) {
    return false;
  }
  return activeBindingCount > 1;
}

// Returns true if the entry was added, false if it was skipped/deduped.
// Mutates acc in place. Extracted to reduce cognitive complexity of the POST handler.
async function accumulateSourceEntry(
  selection: { connectorId: string; connectionId: string | null },
  streamSelectionsBySource: Map<string, Set<string>>,
  packageAccessMode: string,
  ownerSubjectId: string,
  acc: SourceEntryAccumulator,
  caps: ConsentPickerCapabilities,
  oauthError: MountAsAuthorizeContext["oauthError"],
  res: RouteResponse
): Promise<"added" | "skipped" | "rejected"> {
  const { connectorId, connectionId } = selection;
  const manifest = await caps.getConnectorManifest(connectorId).catch(() => null);
  if (!manifest) {
    oauthError(res, 400, "invalid_request", `Unknown connector: ${connectorId}`);
    return "rejected";
  }
  const source = resolveHostedMcpSourceDescriptor(manifest);
  if (!source) {
    oauthError(res, 400, "invalid_request", `Connector ${connectorId} has no valid public source identity`);
    return "rejected";
  }

  const narrowedStreamNames = resolveNarrowedStreams(
    manifest,
    caps.hostedMcpSourceKey({ connectionId, connectorId }),
    streamSelectionsBySource
  );

  if (narrowedStreamNames === "deselected") {
    // Owner deliberately unchecked every declared stream — track for the
    // picker error before looking up eligibility. This keeps a forged stream
    // name from bypassing the manifest boundary or creating a package.
    acc.sourcesWithEmptyStreams.push({
      connectionId: connectionId || null,
      connectorId,
      connectorLabel: manifest.display_name || manifest.name || connectorId,
    });
    return "skipped";
  }

  // Verify the connector has at least one active connection for this owner,
  // whether or not a specific connection was selected. The picker only ever
  // renders rows for connectors the owner actually holds (see
  // `buildConnectorPickerRows`), so this rejects a stale or forged selection
  // — e.g. a source removed since the page was rendered, or a manufactured
  // connector_id — before it can reach the grant engine and hard-fail the
  // whole package with `source.authorization_details_invalid` for every
  // other legitimately-selected source in the same submission. The active
  // set also drives the pin-vs-fan-in decision below: a chosen connection is
  // only an enforceable constraint when there is more than one to choose
  // among.
  let active: ConsentPickerBinding[];
  try {
    active = await caps.listActiveBindingsForGrant({ connectorId, ownerSubjectId });
  } catch {
    oauthError(res, 500, "server_error", "Unable to verify active connection state");
    return "rejected";
  }
  const activeBindingCount = active.length;
  if (activeBindingCount === 0) {
    oauthError(res, 400, "invalid_request", `No active connection for ${connectorId}`, {
      streams: narrowedStreamNames ?? manifest.streams?.map((stream) => stream.name).filter(Boolean) ?? [],
    });
    return "rejected";
  }
  let matchedBinding: ConsentPickerBinding | null = null;
  if (connectionId) {
    // Reject silently-pinning a stale connection: the id must still be one
    // of the connector's currently active bindings.
    matchedBinding = active.find((row) => row.connectorInstanceId === connectionId) || null;
    if (!matchedBinding) {
      oauthError(res, 400, "invalid_request", `Connection ${connectionId} is not active for ${connectorId}`);
      return "rejected";
    }
  }

  const childKey = `${connectorId}|${connectionId || ""}`;
  if (acc.seenChildKeys.has(childKey)) {
    return "skipped";
  }
  acc.seenChildKeys.add(childKey);

  // Pin the validated connection onto the issued child grant only when it
  // disambiguates among sibling connections; otherwise omit it to preserve
  // fan-in. The same value already flows to the package member audit metadata
  // below via acc.connectionIds, so "what the owner saw" and "what is enforced"
  // agree when pinned.
  const pinnedConnectionId = shouldPinSelectedConnection(connectionId, activeBindingCount) ? connectionId : null;
  acc.authorizationDetails.push(
    buildHostedMcpAuthorizationDetailForConnector(
      connectorId,
      narrowedStreamNames,
      packageAccessMode,
      pinnedConnectionId,
      source
    )
  );
  acc.storageBindings.push({ connector_id: connectorId });
  acc.connectionIds.push(connectionId || null);
  acc.sourceMetadata.push({
    connector_display_name: manifest.display_name || manifest.name || connectorId,
    display_name: caps.projectBindingForWire(matchedBinding as ConsentPickerBinding)?.display_name ?? null,
  });
  return "added";
}

// Resolves the narrowed stream name list for a source, accounting for:
//   (a) no manifest streams  → null (wildcard preserved)
//   (b) owner deselected all → "deselected" sentinel
//   (c) all streams selected → null (canonical wildcard)
//   (d) subset selected      → the filtered list
// Extracted to reduce cognitive complexity of accumulateSourceEntry.
function resolveNarrowedStreams(
  manifest: { streams?: Array<{ name?: string }> | null } | null,
  sourceKey: string,
  streamSelectionsBySource: Map<string, Set<string>>
): string[] | null | "deselected" {
  const manifestStreamNames = Array.isArray(manifest?.streams)
    ? manifest.streams.map((s) => s.name).filter((n): n is string => typeof n === "string")
    : [];
  if (manifestStreamNames.length === 0) {
    return null; // (a)
  }

  const selectedStreamSet = streamSelectionsBySource.get(sourceKey) || new Set<string>();
  const validStreamNames = manifestStreamNames.filter((n) => selectedStreamSet.has(n));

  if (validStreamNames.length === 0) {
    return "deselected"; // (b)
  }
  if (validStreamNames.length === manifestStreamNames.length) {
    return null; // (c)
  }
  return validStreamNames; // (d)
}

// ─── PAR-redirect helper (extracted to reduce GET handler complexity) ─────────

// Initiates a pending-consent grant and redirects to its authorization_url.
// Called when authorization_details or connector_id is present on GET /oauth/authorize.
async function initiateGrantAndRedirect(
  res: RouteResponse,
  authorizationDetails: unknown[] | null,
  selectedConnectorId: string | null,
  pkce: {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    state: string | null;
  },
  ctx: MountAsAuthorizeContext,
  req: RouteRequest
): Promise<unknown> {
  let details = authorizationDetails;
  if (!details) {
    const connectorId = selectedConnectorId as string;
    const manifest = await ctx.consentPickerCaps.getConnectorManifest(connectorId).catch(() => null);
    if (!manifest) {
      return ctx.oauthError(res, 400, "invalid_request", `Unknown connector: ${connectorId}`);
    }
    const source = resolveHostedMcpSourceDescriptor(manifest);
    if (!source) {
      return ctx.oauthError(
        res,
        400,
        "invalid_request",
        `Connector ${connectorId} has no valid public source identity`
      );
    }
    details = buildHostedMcpAuthorizationDetailsForConnector(connectorId, source);
  }
  const explicitBaseUrl = ctx.asPublicUrl || (ctx.ignoreAmbientPublicUrls ? null : (process.env.AS_PUBLIC_URL ?? null));
  const output = await ctx.consentStore.initiateGrant(
    { authorization_details: details, client_id: pkce.clientId },
    { baseUrl: ctx.resolvePublicUrl(req, explicitBaseUrl), nativeManifest: ctx.nativeManifest }
  );
  const deviceCode = ctx.consentStore.parseRequestUri(output.request_uri);
  await ctx.stageOAuthAuthorizationCodeRequest({
    clientId: pkce.clientId,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    deviceCode: deviceCode as string,
    expiresInSeconds: output.expires_in || 300,
    redirectUri: pkce.redirectUri,
    state: pkce.state,
  });
  return res.redirect(302, output.authorization_url);
}

// ─── Source-loop helper (extracted to reduce POST handler complexity) ─────────

// Iterates all picker selections, calling accumulateSourceEntry for each.
// Returns the filled accumulator, or null if any source was rejected (response already sent).
async function buildSourceAccumulator(
  selections: Array<{ connectorId: string; connectionId: string | null }>,
  streamSelectionsBySource: Map<string, Set<string>>,
  packageAccessMode: string,
  ownerSubjectId: string,
  caps: ConsentPickerCapabilities,
  oauthError: MountAsAuthorizeContext["oauthError"],
  res: RouteResponse
): Promise<SourceEntryAccumulator | null> {
  const acc: SourceEntryAccumulator = {
    authorizationDetails: [],
    connectionIds: [],
    seenChildKeys: new Set(),
    sourceMetadata: [],
    sourcesWithEmptyStreams: [],
    storageBindings: [],
  };
  for (const selection of selections) {
    // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
    const result = await accumulateSourceEntry(
      selection,
      streamSelectionsBySource,
      packageAccessMode,
      ownerSubjectId,
      acc,
      caps,
      oauthError,
      res
    );
    if (result === "rejected") {
      return null;
    }
  }
  return acc;
}

// ─── Package auth-code issuance (extracted to reduce POST handler complexity) ─

// Stages a package device-code, issues an auth code, and redirects the client.
// Extracted to reduce cognitive complexity of the POST /oauth/authorize/mcp-package handler.
async function issuePackageAuthCodeRedirect(
  res: RouteResponse,
  packageResult: PackageGrantResult,
  pkce: {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    state: string | null;
  },
  ctx: Pick<
    MountAsAuthorizeContext,
    "stageOAuthAuthorizationCodeRequest" | "issueOAuthAuthorizationCodeForPackageDeviceCode" | "oauthError"
  >
): Promise<unknown> {
  const deviceCode = `mcpdev_${randomBytes(16).toString("hex")}`;
  await ctx.stageOAuthAuthorizationCodeRequest({
    clientId: pkce.clientId,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    deviceCode,
    expiresInSeconds: 300,
    redirectUri: pkce.redirectUri,
    state: pkce.state,
  });
  const issued = await ctx.issueOAuthAuthorizationCodeForPackageDeviceCode(deviceCode, {
    packageId: packageResult.package_id,
    token: packageResult.token,
  });
  if (!issued) {
    return ctx.oauthError(res, 500, "server_error", "Failed to issue authorization code for package");
  }
  const redirectUrl = new URL(issued.redirect_uri);
  redirectUrl.searchParams.set("code", issued.code);
  if (issued.state) {
    redirectUrl.searchParams.set("state", issued.state);
  }
  return res.redirect(302, redirectUrl.toString());
}

// Resolves the package access mode from the raw body value.
// Returns the mode string, or null if the value is unknown (caller should reject).
function resolvePackageAccessMode(rawAccessMode: string): string | null {
  if (!rawAccessMode) {
    return HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE;
  }
  if (!HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES.has(rawAccessMode)) {
    return null;
  }
  return rawAccessMode;
}

function hasSubmittedSelectionInput(raw: unknown): boolean {
  if (typeof raw === "string") {
    return raw.trim().length > 0;
  }
  if (Array.isArray(raw)) {
    return raw.some((value) => hasSubmittedSelectionInput(value));
  }
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, unknown>).some((value) => hasSubmittedSelectionInput(value));
  }
  return false;
}

async function renderHostedMcpPickerValidationPage(
  req: RouteRequest,
  res: RouteResponse,
  ctx: Pick<MountAsAuthorizeContext, "consentPickerCaps" | "consentUi" | "ensureCsrfToken" | "providerName">,
  message: string
): Promise<unknown> {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const ownerSubjectId = req?.ownerAuth?.subjectId || "owner_local";
  const csrfToken = ctx.ensureCsrfToken(req, res);
  const html = await renderHostedMcpSourceSelection(
    ownerSubjectId,
    req.body || {},
    csrfToken,
    ctx.providerName,
    ctx.consentPickerCaps,
    ctx.consentUi,
    { validationError: message }
  );
  return res.status(400).send(html);
}

function rejectMissingHostedMcpSelection(
  req: RouteRequest,
  res: RouteResponse,
  ctx: Pick<
    MountAsAuthorizeContext,
    "consentPickerCaps" | "consentUi" | "ensureCsrfToken" | "oauthError" | "providerName"
  >,
  rawSelection: unknown
): Promise<unknown> | unknown {
  if (hasSubmittedSelectionInput(rawSelection)) {
    return ctx.oauthError(res, 400, "invalid_request", "At least one source must be selected");
  }
  return renderHostedMcpPickerValidationPage(
    req,
    res,
    ctx,
    "Select at least one source and one stream inside each selected source before approving."
  );
}

// Builds the package grant and issues the auth code redirect.
// Extracted to reduce cognitive complexity of the POST handler.
async function buildPackageAndRedirect(
  req: RouteRequest,
  res: RouteResponse,
  acc: SourceEntryAccumulator,
  pkce: {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    redirectUri: string;
    state: string | null;
  },
  ownerSubjectId: string,
  ctx: Pick<
    MountAsAuthorizeContext,
    | "createHostedMcpGrantPackage"
    | "consentPickerCaps"
    | "consentUi"
    | "ensureCsrfToken"
    | "issueOAuthAuthorizationCodeForPackageDeviceCode"
    | "oauthError"
    | "providerName"
    | "stageOAuthAuthorizationCodeRequest"
  >
): Promise<unknown> {
  if (acc.sourcesWithEmptyStreams.length > 0) {
    // A checked source without checked streams is ambiguous owner intent. Re-render
    // the picker instead of silently dropping it or returning a raw JSON error.
    const labels = acc.sourcesWithEmptyStreams.map((e) => e.connectorLabel).join(", ");
    return renderHostedMcpPickerValidationPage(
      req,
      res,
      ctx,
      labels
        ? `Choose at least one stream for ${labels}, or clear that source.`
        : "Choose at least one stream inside each selected source, or clear that source."
    );
  }
  if (acc.authorizationDetails.length === 0) {
    return renderHostedMcpPickerValidationPage(req, res, ctx, "Select at least one source before approving.");
  }
  const packageResult = await ctx.createHostedMcpGrantPackage({
    authorizationDetails: acc.authorizationDetails,
    clientId: pkce.clientId,
    connectionIds: acc.connectionIds,
    opts: {},
    sourceMetadata: acc.sourceMetadata,
    storageBindings: acc.storageBindings,
    subjectId: ownerSubjectId,
  });
  return issuePackageAuthCodeRedirect(res, packageResult, pkce, ctx);
}

// ─── Request-intake resolution (extracted to reduce POST handler complexity) ─

interface McpPackageIntake {
  packageAccessMode: string;
  selections: Array<{ connectorId: string; connectionId: string | null }>;
  streamSelectionsBySource: Map<string, Set<string>>;
}

// Resolves the client, decodes the picker selections/streams, and validates
// the access_mode for the POST /oauth/authorize/mcp-package body. Returns
// null once it has already written a response (unknown client, missing
// selection, or an unsupported access_mode) — the caller must stop.
// Extracted to reduce cognitive complexity of the POST handler.
async function resolveMcpPackageIntake(
  req: RouteRequest,
  res: RouteResponse,
  body: Record<string, unknown>,
  pkce: { clientId: string; redirectUri: string },
  ctx: Pick<
    MountAsAuthorizeContext,
    | "consentPickerCaps"
    | "consentUi"
    | "ensureCsrfToken"
    | "ensureRequestId"
    | "getRegisteredClient"
    | "oauthError"
    | "providerName"
    | "selectionParsers"
  >
): Promise<McpPackageIntake | null> {
  const client = await ctx.getRegisteredClient(pkce.clientId, {
    requestId: ctx.ensureRequestId(res),
    traceId: null,
  });
  if (!client) {
    ctx.oauthError(res, 400, "invalid_client", "Unknown client_id");
    return null;
  }
  requireRegisteredRedirectUri(client, pkce.redirectUri);

  const selections = ctx.selectionParsers.parseHostedMcpSelections(body.selection);
  if (selections.length === 0) {
    await rejectMissingHostedMcpSelection(req, res, ctx, body.selection);
    return null;
  }

  // Per-source stream subsets submitted by the picker. Each entry is a
  // base64url(JSON) payload identifying `(connector, connection, stream)`;
  // stream entries whose source was not also checked are ignored so an
  // orphaned stream toggle cannot smuggle authority into a deselected source.
  const { bySource: streamSelectionsBySource } = ctx.selectionParsers.parseHostedMcpStreamSelections(body.stream);

  // Package-level access mode: absent → "continuous" default, unknown → 400.
  const rawAccessMode = typeof body.access_mode === "string" ? body.access_mode.trim() : "";
  const packageAccessMode = resolvePackageAccessMode(rawAccessMode);
  if (!packageAccessMode) {
    ctx.oauthError(res, 400, "invalid_request", "access_mode must be 'single_use' or 'continuous'");
    return null;
  }

  return { packageAccessMode, selections, streamSelectionsBySource };
}

// ─── Route mount ─────────────────────────────────────────────────────────────

export function mountAsAuthorize(app: AppLike, ctx: MountAsAuthorizeContext): void {
  // GET /oauth/authorize
  //
  // Entry point for the OAuth authorization flow. Three paths:
  //   1. No authorization_details and no connector_id — show the hosted MCP
  //      multi-source picker page (consentPickerCaps populates the rows).
  //   2. authorization_details present — PAR-redirect path; initiate a pending
  //      grant and redirect to its authorization_url.
  //   3. connector_id present — shortcut for single-source connector grant;
  //      build authorization_details synthetically and take path 2.
  app.get("/oauth/authorize", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const clientId = requireAuthorizeString(req.query, "client_id");
      const redirectUri = requireAuthorizeString(req.query, "redirect_uri");
      const responseType = requireAuthorizeString(req.query, "response_type");
      const codeChallenge = requireAuthorizeString(req.query, "code_challenge");
      const codeChallengeMethod = requireAuthorizeString(req.query, "code_challenge_method");
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      const state = typeof req.query?.state === "string" ? req.query.state : null;
      validateAuthorizePkce({ codeChallenge, codeChallengeMethod, responseType });

      const client = await ctx.getRegisteredClient(clientId, {
        requestId: ctx.ensureRequestId(res),
        traceId: null,
      });
      if (!client) {
        return ctx.oauthError(res, 400, "invalid_client", "Unknown client_id");
      }
      requireRegisteredRedirectUri(client, redirectUri);

      const authorizationDetails = parseAuthorizeAuthorizationDetails(req.query);
      const rawConnectorId =
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        typeof req.query?.connector_id === "string" && req.query.connector_id.trim()
          ? req.query.connector_id.trim()
          : null;
      // Normalize at the boundary: a URL-shaped first-party connector id
      // (e.g. `https://registry.pdpp.dev/connectors/gmail`) must resolve to
      // its canonical short key (`gmail`) so the pending consent and issued
      // grant store a canonical connector_id, not a registry URL. Unknown or
      // custom ids are preserved as-is so third-party connectors still work.
      const selectedConnectorId = rawConnectorId
        ? (ctx.consentPickerCaps.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId)
        : null;

      if (!(authorizationDetails || selectedConnectorId)) {
        const csrfToken = ctx.ensureCsrfToken(req, res);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        const ownerSubjectId = req?.ownerAuth?.subjectId || "owner_local";
        return res.send(
          await renderHostedMcpSourceSelection(
            ownerSubjectId,
            req.query,
            csrfToken,
            ctx.providerName,
            ctx.consentPickerCaps,
            ctx.consentUi
          )
        );
      }

      return await initiateGrantAndRedirect(
        res,
        authorizationDetails,
        selectedConnectorId,
        { clientId, codeChallenge, codeChallengeMethod, redirectUri, state },
        ctx,
        req
      );
    } catch (err) {
      if (err instanceof ActiveBindingLookupError) {
        return ctx.oauthError(res, 500, "server_error", "Unable to load active connection state");
      }
      const errorCode = (err as { code?: string }).code;
      return ctx.oauthError(
        res,
        400,
        OAUTH_AUTHORIZATION_ERROR_CODES[String(errorCode)] ?? String(errorCode),
        (err as Error).message || "Authorization request rejected"
      );
    }
  });

  // POST /oauth/authorize/mcp-package
  //
  // Hosted MCP multi-source consent POST. The picker submits checked
  // `selection=` values as opaque base64url(JSON) payloads — see
  // server/hosted-mcp-selection.js — plus the PKCE-mirrored authorize
  // params. The handler:
  //   1. Validates the PKCE/authorize params (same shape as GET /oauth/authorize).
  //   2. Decodes each selection structurally to one source-bounded
  //      authorization_details[] entry. No delimiter splitting; URL-shaped
  //      connector ids cannot collapse.
  //   3. Calls createHostedMcpGrantPackage: one independent child grant per source
  //      plus a single package-bound access token.
  //   4. Stages a package-bound OAuth authorization code and redirects the
  //      client back to its redirect_uri with `code=...`.
  // Spec: openspec/changes/canonicalize-connector-keys/specs/agent-consent-bundling/spec.md
  app.post(
    "/oauth/authorize/mcp-package",
    ctx.requireOwnerSession,
    ctx.requireCsrf,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const body = req.body || {};
        const clientId = requireAuthorizeString(body, "client_id");
        const redirectUri = requireAuthorizeString(body, "redirect_uri");
        const responseType = requireAuthorizeString(body, "response_type");
        const codeChallenge = requireAuthorizeString(body, "code_challenge");
        const codeChallengeMethod = requireAuthorizeString(body, "code_challenge_method");
        const state = typeof body.state === "string" ? body.state : null;
        validateAuthorizePkce({ codeChallenge, codeChallengeMethod, responseType });

        const intake = await resolveMcpPackageIntake(req, res, body, { clientId, redirectUri }, ctx);
        if (!intake) {
          return;
        }
        const { selections, streamSelectionsBySource, packageAccessMode } = intake;

        // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
        const ownerSubjectId = req?.ownerAuth?.subjectId || "owner_local";
        const acc = await buildSourceAccumulator(
          selections,
          streamSelectionsBySource,
          packageAccessMode,
          ownerSubjectId,
          ctx.consentPickerCaps,
          ctx.oauthError,
          res
        );
        if (!acc) {
          return;
        }

        // Stage, issue, and redirect — or error if all streams were deselected.
        //
        // MUST be awaited (not bare-returned) inside this try block: a
        // `return somePromise` from a try block resolves the async function
        // via that promise WITHOUT routing its rejection through this
        // function's own catch (JS semantics — the catch only sees
        // synchronous throws and awaited rejections within the try's own
        // execution). A bare return here let CoreSourceAuthorizationError
        // (e.g. a stream with zero eligible connector instances) escape
        // straight past this handler to Fastify's default error handler,
        // producing a raw 500 instead of the typed 4xx envelope below.
        return await buildPackageAndRedirect(
          req,
          res,
          acc,
          { clientId, codeChallenge, codeChallengeMethod, redirectUri, state },
          ownerSubjectId,
          ctx
        );
      } catch (err) {
        const { streams } = err as { streams?: readonly string[] };
        return ctx.oauthError(
          res,
          400,
          (err as { code?: string }).code || "invalid_request",
          (err as Error).message || "Hosted MCP package authorization rejected",
          Array.isArray(streams) && streams.length > 0 ? { streams } : undefined
        );
      }
    }
  );
}
