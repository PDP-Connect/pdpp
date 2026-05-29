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
//     one that guards `/.well-known/oauth-protected-resource/mcp`.
//
// `handleStreamableHttpRequest` and `createPackageRsClient` are injected via
// context because `@pdpp/mcp-server` ships as a JS-only workspace package
// without `.d.ts` declarations, so they cannot be imported directly from a
// strict-mode `.ts` file.

import { isTrustedMetadataRequestOrigin, type ResolvePublicUrlRequest, resolvePublicUrl } from "../metadata.ts";

const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const PROTECTED_RESOURCE_METADATA_URL_LOCAL = "protectedResourceMetadataUrl";

interface RouteRequest extends ResolvePublicUrlRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly method: string;
  readonly path?: string;
  // biome-ignore lint/suspicious/noExplicitAny: raw Fastify/Express req
  readonly raw?: any;
  // biome-ignore lint/suspicious/noExplicitAny: set by requireToken middleware
  readonly tokenInfo?: any;
  readonly url?: string;
}

interface RouteResponse {
  end(): void;
  locals: Record<string, unknown>;
  send(body: unknown): void;
  setHeader(name: string, value: string): void;
  // biome-ignore lint/suspicious/noExplicitAny: framework response chain
  status(code: number): any;
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

/** Opaque MCP server options object. Shape owned by @pdpp/mcp-server. */
// biome-ignore lint/suspicious/noExplicitAny: @pdpp/mcp-server is JS-only
type McpServerOptions = any;

/** Opaque RS client created by createPackageRsClient. */
// biome-ignore lint/suspicious/noExplicitAny: @pdpp/mcp-server is JS-only
type PackageRsClient = any;

export interface MountRsHostedMcpContext {
  /**
   * `createPackageRsClient` from `./package-rs-client.js`.
   * Injected for the same reason — called with a JS-only signature.
   */
  createPackageRsClient(options: {
    providerUrl: string;
    members: readonly GrantPackageMember[];
    fetch: typeof globalThis.fetch;
  }): PackageRsClient;
  /** Resolved RS public URL (or null; adapter derives it per-request). */
  readonly explicitResource: string | null | undefined;
  /** From auth.js: resolve active grant-package members for a package token. */
  getGrantPackageAccess(packageId: string): Promise<GrantPackageAccess | null>;
  /**
   * `handleStreamableHttpRequest` from `@pdpp/mcp-server/server`.
   * Injected because the package is JS-only without type declarations.
   */
  handleStreamableHttpRequest(request: Request, options: McpServerOptions): Promise<Response>;
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

function protectedResourceMetadataUrlForResource(resource: string): string {
  const parsed = new URL(resource);
  const resourcePath = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.origin}${PROTECTED_RESOURCE_METADATA_PATH}${resourcePath}${parsed.search}`;
}

function buildMcpWebRequest(req: RouteRequest, resource: string): Request {
  const url = new URL(
    // biome-ignore lint/suspicious/noExplicitAny: raw framework req
    (req.raw as any)?.url ?? req.url ?? req.path ?? "/mcp",
    resource
  );
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, String(item));
      }
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }

  let body: Buffer | string | undefined;
  if (!["GET", "HEAD"].includes(req.method)) {
    if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
      body = req.body as Buffer | string;
    } else if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  const init: RequestInit =
    body === undefined ? { method: req.method, headers } : { method: req.method, headers, body };
  return new Request(url.toString(), init);
}

async function sendWebResponse(res: RouteResponse, response: Response): Promise<void> {
  res.status(response.status);
  response.headers.forEach((value: string, key: string) => {
    res.setHeader(key, value);
  });
  if (response.status === 204 || response.status === 304) {
    res.end();
    return;
  }
  const body = Buffer.from(await response.arrayBuffer());
  res.send(body);
}

export function mountRsHostedMcp(app: AppLike, ctx: MountRsHostedMcpContext): void {
  const { explicitResource, trustedMetadataHosts, referenceRevision } = ctx;

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
      const resource = `${resolvePublicUrl(req, explicitResource)}/mcp`;
      res.locals[PROTECTED_RESOURCE_METADATA_URL_LOCAL] = protectedResourceMetadataUrlForResource(resource);
    }
    next();
  }

  async function handleHostedMcp(req: RouteRequest, res: RouteResponse): Promise<void> {
    const resource = resolvePublicUrl(req, explicitResource);
    const authHeader = req.headers.authorization;
    const authValue = Array.isArray(authHeader) ? (authHeader[0] ?? "") : (authHeader ?? "");
    const inboundToken = authValue.slice(7);

    let mcpServerOptions: McpServerOptions;
    if (req.tokenInfo?.pdpp_token_kind === "mcp_package") {
      const access = await ctx.getGrantPackageAccess(req.tokenInfo.grant_package_id as string);
      if (!access || access.members.length === 0) {
        ctx.pdppError(res, 403, "package_revoked", "Grant package is revoked or has no active members");
        return;
      }
      const rsClient = ctx.createPackageRsClient({
        providerUrl: resource,
        members: access.members,
        fetch: globalThis.fetch,
      });
      mcpServerOptions = {
        providerUrl: resource,
        rsClient,
        fetch: globalThis.fetch,
        serverName: "pdpp-reference-mcp",
        serverVersion: referenceRevision,
      };
      res.setHeader("x-pdpp-grant-package-id", req.tokenInfo.grant_package_id as string);
      res.setHeader("x-pdpp-grant-package-member-count", String(access.members.length));
    } else {
      mcpServerOptions = {
        providerUrl: resource,
        accessToken: inboundToken,
        fetch: globalThis.fetch,
        serverName: "pdpp-reference-mcp",
        serverVersion: referenceRevision,
      };
    }

    const webRequest = buildMcpWebRequest(req, resource);
    const response = await ctx.handleStreamableHttpRequest(webRequest, mcpServerOptions);
    await sendWebResponse(res, response);
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
