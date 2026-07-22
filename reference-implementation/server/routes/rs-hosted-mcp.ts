// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the hosted MCP surface: `GET /mcp`, `POST /mcp`,
// `DELETE /mcp`.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§5.4). These three routes
// proxy inbound MCP requests through `@pdpp/mcp-server` using either a
// single-bearer `RsClient` (standard client token) or a fan-out
// `PackageRsClient` (mcp_package token). Auth posture:
//   - `requireToken` — rejects unauthenticated and owner-token requests
//   - `requireClientOrMcpPackage` — only `client` or `mcp_package` token kinds
//     may reach the MCP surface; owner tokens are always rejected.
//   - `requireTrustedHostedMcpResource` — host-based guard identical to the
//     one that guards the canonical provider protected-resource metadata.
//
// `handleStreamableHttpRequest` and `createPackageRsClient` are injected via
// context because `@pdpp/mcp-server` ships as a JS-only workspace package
// without `.d.ts` declarations, so they cannot be imported directly from a
// strict-mode `.ts` file.

import {
  isTrustedMetadataRequestOrigin,
  protectedResourceMetadataUrlForResource,
  type ResolvePublicUrlRequest,
  resolvePublicUrl,
} from "../metadata.ts";

const PROTECTED_RESOURCE_METADATA_URL_LOCAL = "protectedResourceMetadataUrl";

interface RouteRequest extends ResolvePublicUrlRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly method: string;
  readonly path?: string;
  readonly raw?: { readonly url?: string };
  readonly tokenInfo?: {
    readonly grant_package_id?: string;
    readonly pdpp_token_kind?: string;
  };
  readonly url?: string;
}

interface RouteResponse {
  end(): void;
  locals: Record<string, unknown>;
  send(body: unknown): void;
  setHeader(name: string, value: string): void;
  status(code: number): RouteResponse;
}

type Middleware = (req: RouteRequest, res: RouteResponse, next: () => void) => void;
type Handler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  delete(path: string, ...handlers: (Middleware | Handler)[]): AppLike;
  get(path: string, ...handlers: (Middleware | Handler)[]): AppLike;
  post(path: string, ...handlers: (Middleware | Handler)[]): AppLike;
}

export interface GrantPackageMember {
  readonly accessToken: string;
  readonly grantId: string;
}

export interface GrantPackageAccess {
  readonly members: readonly GrantPackageMember[];
}

interface McpServerIcon {
  readonly mimeType?: string;
  readonly sizes?: readonly string[];
  readonly src: string;
}

interface McpServerOptions {
  readonly accessToken?: string;
  readonly fetch: typeof globalThis.fetch;
  readonly providerUrl: string;
  readonly rsClient?: unknown;
  readonly serverIcons?: readonly McpServerIcon[];
  readonly serverName: string;
  readonly serverVersion: string;
}

export interface MountRsHostedMcpContext {
  /**
   * `createPackageRsClient` from `./package-rs-client.js`.
   * Injected for the same reason — called with a JS-only signature.
   */
  createPackageRsClient(options: {
    providerUrl: string;
    members: readonly GrantPackageMember[];
    fetch: typeof globalThis.fetch;
  }): unknown;
  /**
   * `createRsClient` from `./package-rs-client.js` — builds one single-bearer
   * RsClient against a chosen fetch base. Injected for the same JS-only reason.
   * Used for the standalone (`client`-token) path so its self-calls can use the
   * internal RS base too (parity with the package path's child clients).
   */
  createRsClient(options: { providerUrl: string; accessToken: string; fetch: typeof globalThis.fetch }): unknown;
  /** Resolved RS public URL (or null; adapter derives it per-request). */
  readonly explicitResource: string | null | undefined;
  /** From auth.js: resolve active grant-package members for a package token. */
  getGrantPackageAccess(packageId: string): Promise<GrantPackageAccess | null>;
  /**
   * `handleStreamableHttpRequest` from `@pdpp/mcp-server/server`.
   * Injected because the package is JS-only without type declarations.
   */
  handleStreamableHttpRequest(request: Request, options: McpServerOptions): Promise<Response>;
  /**
   * Trusted INTERNAL resource-server base URL for the adapter's own
   * server-internal self-calls (the child `RsClient` fetch base). Sourced
   * EXPLICITLY from `opts.rsInternalUrl` or the operator's `PDPP_RS_URL`
   * (see `startServer`) — a loopback/cluster address, NOT request-derived from
   * `Host`/`X-Forwarded-*`. NOTE: it is intentionally NOT the bare
   * `referenceTopology.rsInternalUrl` default (`http://localhost:7663`): that
   * default is skipped so ephemeral-port test harnesses and deployments that
   * do not set `PDPP_RS_URL` resolve this to null and fall back to the public
   * resource (current behavior preserved). Used as the child fetch base only;
   * the advertised `resource`, discovery metadata, and
   * `mcpServerOptions.providerUrl` always stay the public origin.
   *
   * Spec: openspec/changes/route-hosted-mcp-adapter-self-calls-internally/
   */
  readonly internalResource?: string | null;
  /** Standard error helper. */
  pdppError(res: RouteResponse, status: number, code: string, message: string): unknown;
  /** Reference server revision string for MCP server identification. */
  readonly referenceRevision: string;
  /** Guard: only `client` or `mcp_package` token kinds allowed. */
  requireClientOrMcpPackage: Middleware;
  /** Standard `requireToken` middleware set by auth wiring. */
  requireToken: Middleware;
  /** PDPP_TRUSTED_HOSTS allowlist (or null). */
  readonly trustedMetadataHosts: string | null | undefined;
}

function addMcpWebRequestHeader(headers: Headers, name: string, value: string | string[] | undefined): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      headers.append(name, String(item));
    }
    return;
  }
  if (value !== undefined) {
    headers.set(name, String(value));
  }
}

function buildMcpWebRequestHeaders(req: RouteRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    addMcpWebRequestHeader(headers, name, value);
  }
  return headers;
}

function buildMcpWebRequestBody(req: RouteRequest, headers: Headers): Buffer | string | undefined {
  if (["GET", "HEAD"].includes(req.method)) {
    return;
  }
  if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
    return req.body as Buffer | string;
  }
  if (req.body === undefined) {
    return;
  }

  const body = JSON.stringify(req.body);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return body;
}

function buildMcpWebRequestInit(req: RouteRequest, headers: Headers): RequestInit {
  const body = buildMcpWebRequestBody(req, headers);
  const init: RequestInit =
    body === undefined ? { method: req.method, headers } : { method: req.method, headers, body };
  return init;
}

function buildMcpWebRequest(req: RouteRequest, resource: string): Request {
  const url = new URL(req.raw?.url ?? req.url ?? req.path ?? "/mcp", resource);
  const headers = buildMcpWebRequestHeaders(req);
  const init = buildMcpWebRequestInit(req, headers);
  return new Request(url.toString(), init);
}

function extractInboundMcpToken(req: RouteRequest): string {
  const authHeader = req.headers.authorization;
  const authValue = Array.isArray(authHeader) ? (authHeader[0] ?? "") : (authHeader ?? "");
  return authValue.slice(7);
}

interface SendWebResponseOptions {
  readonly iconLink?: string;
}

async function sendWebResponse(
  res: RouteResponse,
  response: Response,
  options: SendWebResponseOptions = {}
): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value: string, key: string) => {
    res.setHeader(key, value);
  });
  if (options.iconLink) {
    const existing = response.headers.get("link");
    res.setHeader("link", existing ? `${existing}, ${options.iconLink}` : options.iconLink);
  }
  if (response.status === 204 || response.status === 304) {
    res.end();
    return;
  }
  const body = Buffer.from(await response.arrayBuffer());
  res.send(body);
}

function hostedMcpIconUrl(resource: string): string {
  return new URL("/icon.svg", resource).toString();
}

function hostedMcpIcons(resource: string): readonly McpServerIcon[] {
  return [{ src: hostedMcpIconUrl(resource), mimeType: "image/svg+xml", sizes: ["any"] }];
}

function hostedMcpIconLink(resource: string): string {
  return `<${hostedMcpIconUrl(resource)}>; rel="icon"; type="image/svg+xml"`;
}

export function mountRsHostedMcp(app: AppLike, ctx: MountRsHostedMcpContext): void {
  const { explicitResource, internalResource, trustedMetadataHosts, referenceRevision } = ctx;

  function requireTrustedHostedMcpResource(req: RouteRequest, res: RouteResponse, next: () => void): void {
    if (isTrustedMetadataRequestOrigin(req, explicitResource, trustedMetadataHosts)) {
      next();
      return;
    }
    ctx.pdppError(
      res,
      421,
      "misdirected_request",
      "Host-derived metadata requires a local/private request host or PDPP_TRUSTED_HOSTS allowlist"
    );
  }

  function setHostedMcpProtectedResourceMetadata(req: RouteRequest, res: RouteResponse, next: () => void): void {
    if (isTrustedMetadataRequestOrigin(req, explicitResource, trustedMetadataHosts)) {
      const resource = resolvePublicUrl(req, explicitResource);
      res.locals[PROTECTED_RESOURCE_METADATA_URL_LOCAL] = protectedResourceMetadataUrlForResource(`${resource}/mcp`);
      res.setHeader("link", hostedMcpIconLink(resource));
    }
    next();
  }

  async function buildPackageMcpServerOptions(
    req: RouteRequest,
    res: RouteResponse,
    resource: string,
    internalBase: string
  ): Promise<McpServerOptions | null> {
    const access = await ctx.getGrantPackageAccess(req.tokenInfo?.grant_package_id as string);
    if (!access || access.members.length === 0) {
      ctx.pdppError(res, 403, "package_revoked", "Grant package is revoked or has no active members");
      return null;
    }
    const rsClient = ctx.createPackageRsClient({
      // Child self-calls use the internal base, not the public edge.
      providerUrl: internalBase,
      members: access.members,
      fetch: globalThis.fetch,
    });
    const mcpServerOptions = {
      providerUrl: resource,
      rsClient,
      fetch: globalThis.fetch,
      serverIcons: hostedMcpIcons(resource),
      serverName: "pdpp-reference-mcp",
      serverVersion: referenceRevision,
    } satisfies McpServerOptions;
    res.setHeader("x-pdpp-grant-package-id", req.tokenInfo?.grant_package_id as string);
    res.setHeader("x-pdpp-grant-package-member-count", String(access.members.length));
    return mcpServerOptions;
  }

  function buildStandaloneMcpServerOptions(
    resource: string,
    internalBase: string,
    accessToken: string
  ): McpServerOptions {
    // Standalone (`client`-token) path: build the single-bearer RsClient
    // against the internal base so its self-calls avoid the public-edge
    // hairpin too — parity with the package path's child clients. The
    // advertised `providerUrl`
    // stays the public `resource` (display/provenance only; all fetches go
    // through the injected rsClient). When no internal base is configured,
    // internalBase === resource, so this is a no-op vs prior behavior.
    const rsClient = ctx.createRsClient({
      providerUrl: internalBase,
      accessToken,
      fetch: globalThis.fetch,
    });
    return {
      providerUrl: resource,
      rsClient,
      fetch: globalThis.fetch,
      serverIcons: hostedMcpIcons(resource),
      serverName: "pdpp-reference-mcp",
      serverVersion: referenceRevision,
    };
  }

  async function buildHostedMcpServerOptions(
    req: RouteRequest,
    res: RouteResponse,
    resource: string,
    internalBase: string,
    inboundToken: string
  ): Promise<McpServerOptions | null> {
    if (req.tokenInfo?.pdpp_token_kind === "mcp_package") {
      return buildPackageMcpServerOptions(req, res, resource, internalBase);
    }
    return buildStandaloneMcpServerOptions(resource, internalBase, inboundToken);
  }

  async function handleHostedMcp(req: RouteRequest, res: RouteResponse): Promise<void> {
    // Advertised identity (what clients discover and call) — always public.
    const resource = resolvePublicUrl(req, explicitResource);
    // Server-internal fetch base for the adapter's own child-grant self-calls.
    // Prefer the operator-configured internal RS base; fall back to the
    // advertised public resource when none is configured (current behavior).
    // The internal base is fetch-only: it is never advertised, never written
    // into discovery metadata, and never carried in issued-token audiences.
    const internalBase = internalResource ?? resource;
    const inboundToken = extractInboundMcpToken(req);

    const mcpServerOptions = await buildHostedMcpServerOptions(req, res, resource, internalBase, inboundToken);
    if (!mcpServerOptions) {
      return;
    }

    const webRequest = buildMcpWebRequest(req, resource);
    const response = await ctx.handleStreamableHttpRequest(webRequest, mcpServerOptions);
    await sendWebResponse(res, response, { iconLink: hostedMcpIconLink(resource) });
  }

  const middlewareChain = [
    requireTrustedHostedMcpResource as Middleware,
    setHostedMcpProtectedResourceMetadata as Middleware,
    ctx.requireToken,
    ctx.requireClientOrMcpPackage,
    handleHostedMcp as Handler,
  ] as const;

  app.get("/mcp", ...middlewareChain);
  app.post("/mcp", ...middlewareChain);
  app.delete("/mcp", ...middlewareChain);
}
