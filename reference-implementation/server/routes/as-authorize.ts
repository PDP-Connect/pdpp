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
  buildHostedMcpAuthorizationDetailForConnector,
  buildHostedMcpAuthorizationDetailsForConnector,
  HOSTED_MCP_PICKER_DEFAULT_ACCESS_MODE,
  HOSTED_MCP_PICKER_SUPPORTED_ACCESS_MODES,
  parseAuthorizeAuthorizationDetails,
  renderHostedMcpSourceSelection,
  requireAuthorizeString,
  requireRegisteredRedirectUri,
  validateAuthorizePkce,
} from "./as-consent-ui-helpers.ts";

// ─── Minimal structural types ────────────────────────────────────────────────

interface RouteRequest {
  readonly body: Record<string, unknown> | null | undefined;
  ownerAuth?: { subjectId?: string };
  readonly query: Record<string, unknown>;
}

interface RouteResponse {
  redirect(status: number, url: string): unknown;
  send(body: string): unknown;
  status(status: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler | MiddlewareHandler>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler | MiddlewareHandler>[]): AppLike;
}

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
  initiateGrant(
    params: { client_id: string; authorization_details: unknown },
    opts: { baseUrl: string; nativeManifest: unknown }
  ): Promise<ConsentStoreOutput>;
  parseRequestUri(requestUri: string): string | null;
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
  parseHostedMcpSelections(raw: unknown): Array<{ connectorId: string; connectionId: string | null }>;
  parseHostedMcpStreamSelections(raw: unknown): {
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
  createHostedMcpGrantPackage(args: {
    authorizationDetails: unknown[];
    clientId: string;
    connectionIds: Array<string | null>;
    opts: Record<string, never>;
    sourceMetadata: Array<{ connector_display_name: string; display_name: string | null }>;
    storageBindings: Array<{ connector_id: string }>;
    subjectId: string;
  }): Promise<PackageGrantResult>;
  /** Reads the owner CSRF token from session, setting a new one if absent. */
  ensureCsrfToken(req: RouteRequest, res: RouteResponse): string;
  /** Retrieves a registered OAuth client by client_id, or null if not found. */
  getRegisteredClient(clientId: string): Promise<OAuthClient | null>;
  /** Whether to ignore ambient PUBLIC_URL env vars when resolving the base URL. */
  ignoreAmbientPublicUrls: boolean;
  /** Issues an OAuth authorization code bound to a package device-code. */
  issueOAuthAuthorizationCodeForPackageDeviceCode(
    deviceCode: string,
    args: { packageId: string; token: string }
  ): Promise<IssuedCode | null>;
  /** Resolved native manifest for this server instance, or null. */
  nativeManifest: unknown;
  /** Writes an OAuth error envelope and returns. */
  oauthError(res: unknown, status: number, code: string, message: string): unknown;
  /** Provider name for picker HTML rendering. */
  providerName: string;
  /** CSRF enforcement middleware. */
  requireCsrf: MiddlewareHandler;
  /** Owner-session enforcement middleware. */
  requireOwnerSession: MiddlewareHandler;
  /** Resolves the public base URL from the request and any explicit override. */
  resolvePublicUrl(req: RouteRequest, explicitBaseUrl: string | null): string;
  /** Hosted-MCP selection parsers (from hosted-mcp-selection.js). */
  selectionParsers: HostedMcpSelectionParsers;
  /** Stages an OAuth authorization code request (PKCE device-code shell). */
  stageOAuthAuthorizationCodeRequest(args: {
    clientId: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    deviceCode: string;
    expiresInSeconds: number;
    redirectUri: string;
    state: string | null;
  }): Promise<void>;
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

  let matchedBinding: ConsentPickerBinding | null = null;
  if (connectionId) {
    // Verify the requested connection is currently active for this
    // owner+connector. Reject silently-pinning a stale connection.
    const active = await caps
      .listActiveBindingsForGrant({ connectorId, ownerSubjectId })
      .catch(() => [] as ConsentPickerBinding[]);
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

  const narrowedStreamNames = resolveNarrowedStreams(
    manifest,
    caps.hostedMcpSourceKey({ connectorId, connectionId }),
    streamSelectionsBySource
  );

  if (narrowedStreamNames === "deselected") {
    // Owner deliberately unchecked every stream — track for the error message.
    acc.sourcesWithEmptyStreams.push({
      connectorId,
      connectionId: connectionId || null,
      connectorLabel: manifest.display_name || manifest.name || connectorId,
    });
    return "skipped";
  }

  acc.authorizationDetails.push(
    buildHostedMcpAuthorizationDetailForConnector(connectorId, narrowedStreamNames, packageAccessMode)
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
    ? (manifest?.streams?.map((s) => s.name).filter((n): n is string => typeof n === "string") ?? [])
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
  const details = authorizationDetails || buildHostedMcpAuthorizationDetailsForConnector(selectedConnectorId as string);
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
      const state = typeof req.query?.state === "string" ? req.query.state : null;
      validateAuthorizePkce({ codeChallenge, codeChallengeMethod, responseType });

      const client = await ctx.getRegisteredClient(clientId);
      if (!client) {
        return ctx.oauthError(res, 400, "invalid_client", "Unknown client_id");
      }
      requireRegisteredRedirectUri(client, redirectUri);

      const authorizationDetails = parseAuthorizeAuthorizationDetails(req.query);
      const rawConnectorId =
        typeof req.query?.connector_id === "string" && req.query.connector_id.trim()
          ? req.query.connector_id.trim()
          : null;
      // Normalize at the boundary: a URL-shaped first-party connector id
      // (e.g. `https://registry.pdpp.org/connectors/gmail`) must resolve to
      // its canonical short key (`gmail`) so the pending consent and issued
      // grant store a canonical connector_id, not a registry URL. Unknown or
      // custom ids are preserved as-is so third-party connectors still work.
      const selectedConnectorId = rawConnectorId
        ? (ctx.consentPickerCaps.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId)
        : null;

      if (!(authorizationDetails || selectedConnectorId)) {
        const csrfToken = ctx.ensureCsrfToken(req, res);
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

      return initiateGrantAndRedirect(
        res,
        authorizationDetails,
        selectedConnectorId,
        { clientId, codeChallenge, codeChallengeMethod, redirectUri, state },
        ctx,
        req
      );
    } catch (err) {
      return ctx.oauthError(
        res,
        400,
        (err as { code?: string }).code || "invalid_request",
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

        const client = await ctx.getRegisteredClient(clientId);
        if (!client) {
          return ctx.oauthError(res, 400, "invalid_client", "Unknown client_id");
        }
        requireRegisteredRedirectUri(client, redirectUri);

        const selections = ctx.selectionParsers.parseHostedMcpSelections(body.selection);
        if (selections.length === 0) {
          return rejectMissingHostedMcpSelection(req, res, ctx, body.selection);
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
          return ctx.oauthError(res, 400, "invalid_request", "access_mode must be 'single_use' or 'continuous'");
        }

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
        return buildPackageAndRedirect(
          req,
          res,
          acc,
          { clientId, codeChallenge, codeChallengeMethod, redirectUri, state },
          ownerSubjectId,
          ctx
        );
      } catch (err) {
        return ctx.oauthError(
          res,
          400,
          (err as { code?: string }).code || "invalid_request",
          (err as Error).message || "Hosted MCP package authorization rejected"
        );
      }
    }
  );
}
