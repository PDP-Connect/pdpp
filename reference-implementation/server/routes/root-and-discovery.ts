// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapters for the reference server's content-negotiated root
// landing pages and the public OAuth/RS metadata endpoints.
//
// This module is a behaviour-preserving extraction from `server/index.js`.
// Per the OpenSpec change `split-reference-server-by-route-family`, route
// adapters live beside other server-only wiring (`server/transport.js`,
// `server/owner-auth.ts`, etc.) and own only HTTP wiring: request id and
// reference-revision header setup live in `app.use(...)` global middleware
// in the composition root, response writing and capability composition are
// owned by the host adapter functions below, and the protocol/business
// semantics for each route live in the `operations/*` modules. No new
// router/controller/repository abstraction is introduced; each function
// here delegates straight to the existing operation it called from
// `server/index.js`.
//
// Mount points are preserved exactly. Each `mount...` function registers
// one route at the same point in registration order where `server/index.js`
// previously registered it inline. Middleware order, owner-session
// posture, response envelopes, status codes, and spine event emission are
// unchanged.

import {
  type AsAuthorizationServerMetadataBuilderInput,
  type AsAuthorizationServerPublicClient,
  executeAsAuthorizationServerMetadata,
} from "../../operations/as-authorization-server-metadata/index.ts";
import { executeAsDiscoveryIndex } from "../../operations/as-discovery-index/index.ts";
import { executeRsDiscoveryIndex } from "../../operations/rs-discovery-index/index.ts";
import {
  executeRsProtectedResourceMetadata,
  type RsProtectedResourceMetadataClientEventSubscriptionsCapability,
  type RsProtectedResourceMetadataHybridCapability,
  type RsProtectedResourceMetadataLexicalCapability,
  type RsProtectedResourceMetadataSemanticCapability,
} from "../../operations/rs-protected-resource-metadata/index.ts";

// PDPP exposes an Express-shaped wrapper from `server/transport.js`. The
// shape consumed by route adapters is a small subset: `app.get(path, opts?,
// ...handlers)`. The transport file is untyped (`.js`), so we describe the
// surface structurally here without re-implementing it.

interface RouteOptions {
  contract: string;
}

interface RouteRequest {
  readonly hostname: string;
  readonly protocol: string;
}

interface RouteResponse {
  json(body: unknown): unknown;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown;

interface AppLike {
  get(path: string, opts: RouteOptions, handler: RouteHandler): AppLike;
}

// ─── AS root (`GET /`) ──────────────────────────────────────────────────────

export interface MountAsRootContext {
  providerName: string;
  referenceRevision: string;
  servedRootLandingIfBrowser(
    req: unknown,
    res: unknown,
    args: { role: "authorization_server"; providerName: string; referenceRevision: string }
  ): boolean;
}

export function mountAsRoot(app: AppLike, ctx: MountAsRootContext): void {
  // Cold-start discovery index: a tiny unauthenticated pointer at `/` so an
  // integrator probing the AS root learns where the AS well-known endpoint
  // lives without trial-and-error. The body intentionally restates the
  // running reference revision (also exposed via the response header) so an
  // LLM agent has a single document to read.
  // Discovery-index envelope semantics live in the canonical
  // `as.discovery.index` operation (operations/as-discovery-index). This
  // route is an Express host adapter: it owns request-id/header wiring and
  // response writing; the operation owns the envelope shape.
  app.get("/", { contract: "getAsDiscoveryIndex" }, (req, res) => {
    // Browsers see an operator/admin landing that names this AS, names the
    // configured console origin, and links to the well-known discovery
    // endpoint. JSON-shaped clients still receive the existing envelope
    // byte-for-byte. See openspec/changes/split-public-site-and-operator-console.
    if (
      ctx.servedRootLandingIfBrowser(req, res, {
        role: "authorization_server",
        providerName: ctx.providerName,
        referenceRevision: ctx.referenceRevision,
      })
    ) {
      return;
    }
    res.json(
      executeAsDiscoveryIndex({
        providerName: ctx.providerName,
        referenceRevision: ctx.referenceRevision,
      })
    );
  });
}

// ─── AS `/.well-known/oauth-authorization-server` ───────────────────────────

export interface MountAsAuthorizationServerMetadataContext {
  buildAuthorizationServerMetadata(input: AsAuthorizationServerMetadataBuilderInput): unknown;
  cimdEnabled?: boolean;
  dynamicClientRegistrationEnabled: boolean;
  publicClientMetadataForAuthorizationServer(clients: unknown[]): readonly AsAuthorizationServerPublicClient[];
  rejectUntrustedMetadataHost(
    req: unknown,
    res: unknown,
    explicitUrl: unknown,
    trustedHosts: unknown,
    options?: unknown
  ): boolean;
  resolveExplicitIssuer(): string | null;
  resolvePreRegisteredPublicClients(): unknown[];
  resolvePublicUrl(req: unknown, explicit: unknown): string;
  trustedMetadataHosts: unknown;
}

export function mountAsAuthorizationServerMetadata(app: AppLike, ctx: MountAsAuthorizationServerMetadataContext): void {
  // RFC 8414 authorization-server metadata. The metadata-document envelope
  // lives in the canonical `as.authorization_server.metadata` operation
  // (operations/as-authorization-server-metadata). The host adapter resolves
  // the public issuer URL from explicit opts or ambient env, and supplies
  // the metadata-builder dependency.
  app.get("/.well-known/oauth-authorization-server", { contract: "getAuthorizationServerMetadata" }, (req, res) => {
    const explicitIssuer = ctx.resolveExplicitIssuer();
    if (ctx.rejectUntrustedMetadataHost(req, res, explicitIssuer, ctx.trustedMetadataHosts)) {
      return;
    }
    const issuer = ctx.resolvePublicUrl(req, explicitIssuer);
    res.json(
      executeAsAuthorizationServerMetadata(
        {
          issuer,
          dynamicClientRegistrationEnabled: ctx.dynamicClientRegistrationEnabled,
          cimdEnabled: ctx.cimdEnabled === true,
          preRegisteredPublicClients: ctx.publicClientMetadataForAuthorizationServer(
            ctx.resolvePreRegisteredPublicClients()
          ),
        },
        { buildAuthorizationServerMetadata: ctx.buildAuthorizationServerMetadata }
      )
    );
  });
}

// ─── RS root (`GET /`) ──────────────────────────────────────────────────────

export interface MountRsRootContext {
  // Advisory owner-agent onboarding wiring. Mirrors the protected-resource
  // handler: the root pointer surfaces the same advisory block so a local
  // owner agent can derive the flow from the cold-start entrypoint. All three
  // callbacks/values are the same host capabilities the protected-resource
  // metadata route already uses, so the root and `.well-known` documents stay
  // consistent and forwarded-origin-safe. See
  // openspec/changes/add-trusted-owner-agent-onboarding.
  agentDiscoveryOrigin: string | null;
  asPort: number;
  buildOwnerAgentOnboardingMetadata(args: { origin: string | null; resource: string; issuer: string }): unknown;
  explicitResource: unknown;
  providerName: string;
  referenceRevision: string;
  rejectUntrustedMetadataHost(
    req: unknown,
    res: unknown,
    explicitUrl: unknown,
    trustedHosts: unknown,
    options?: unknown
  ): boolean;
  resolveExplicitIssuer(): string | null;
  resolvePublicUrl(req: unknown, explicit: unknown): string;
  resolveSiblingPublicUrl(req: unknown, origin: string): string;
  servedRootLandingIfBrowser(
    req: unknown,
    res: unknown,
    args: { role: "resource_server"; providerName: string; referenceRevision: string }
  ): boolean;
  shouldUseDirectRequestOrigin(req: unknown, explicit: unknown): boolean;
  trustedMetadataHosts: unknown;
}

export function mountRsRoot(app: AppLike, ctx: MountRsRootContext): void {
  // Cold-start discovery index: a tiny unauthenticated pointer at `/` so a
  // probe at the RS root learns where the well-known endpoint, capability
  // schema, and core query base live before guessing at REST/LLM-API
  // conventions. See openspec/changes/polish-reference-api-discovery-seams.
  app.get("/", { contract: "getRsDiscoveryIndex" }, (req, res) => {
    // Browser-friendly landing for the RS root (mirrors the AS handler).
    // JSON discovery is preserved byte-for-byte for JSON-shaped clients.
    // See openspec/changes/split-public-site-and-operator-console.
    if (
      ctx.servedRootLandingIfBrowser(req, res, {
        role: "resource_server",
        providerName: ctx.providerName,
        referenceRevision: ctx.referenceRevision,
      })
    ) {
      return;
    }
    const { envelope } = executeRsDiscoveryIndex({
      providerName: ctx.providerName,
      referenceRevision: ctx.referenceRevision,
    });
    // Advisory owner-agent onboarding pointer. Only resolve host-derived URLs
    // and reject untrusted hosts when an approval origin exists (composed
    // mode); a direct/ephemeral root keeps the byte-for-byte JSON envelope
    // without an owner-agent block and without the untrusted-host guard.
    if (ctx.agentDiscoveryOrigin) {
      if (ctx.rejectUntrustedMetadataHost(req, res, ctx.explicitResource, ctx.trustedMetadataHosts)) {
        return;
      }
      const resource = ctx.resolvePublicUrl(req, ctx.explicitResource);
      const explicitIssuer = ctx.resolveExplicitIssuer();
      const fallbackIssuer = `${(req as RouteRequest).protocol}://${(req as RouteRequest).hostname}:${ctx.asPort}`;
      const issuerUsesDirectRequestOrigin = ctx.shouldUseDirectRequestOrigin(req, explicitIssuer);
      const issuerSource = issuerUsesDirectRequestOrigin ? fallbackIssuer : explicitIssuer || fallbackIssuer;
      if (
        ctx.rejectUntrustedMetadataHost(req, res, issuerSource, ctx.trustedMetadataHosts, {
          forceHostDerived: issuerUsesDirectRequestOrigin || !explicitIssuer,
        })
      ) {
        return;
      }
      const issuer = ctx.resolvePublicUrl(req, issuerSource);
      const ownerAgentOnboarding = ctx.buildOwnerAgentOnboardingMetadata({
        origin: ctx.resolveSiblingPublicUrl(req, ctx.agentDiscoveryOrigin),
        resource,
        issuer,
      });
      if (ownerAgentOnboarding) {
        res.json({ ...envelope, pdpp_owner_agent_onboarding: ownerAgentOnboarding });
        return;
      }
    }
    res.json(envelope);
  });
}

// ─── RS `/.well-known/oauth-protected-resource` ─────────────────────────────

export interface MountRsProtectedResourceMetadataContext {
  agentDiscoveryOrigin: string | null;
  asPort: number;
  buildAgentDiscoveryMetadata(
    origin: string | null,
    opts?: { noOwnerToken?: boolean; docsOrigin?: string | null; mcpAuthorization?: unknown }
  ): unknown;
  buildDefaultHybridCapability(args: {
    lexicalAvailable: true;
    semanticAvailable: true;
  }): RsProtectedResourceMetadataHybridCapability | null;
  // Advisory trusted-owner-agent onboarding block. Returns `null` (omitting
  // the block) when owner-agent onboarding is not safely configured — the host
  // passes the resolved trusted public `resource`/`issuer` and the
  // composed-mode approval `origin` (null in direct/ephemeral mode). See
  // openspec/changes/add-trusted-owner-agent-onboarding.
  buildOwnerAgentOnboardingMetadata(args: { origin: string | null; resource: string; issuer: string }): unknown;
  buildProtectedResourceMetadata(input: unknown): unknown;
  explicitResource: unknown;
  isHybridSuppressed(): boolean;
  nativeMode: boolean;
  pdppProviderConnectVersion: string;
  providerName: string;
  rejectUntrustedMetadataHost(
    req: unknown,
    res: unknown,
    explicitUrl: unknown,
    trustedHosts: unknown,
    options?: unknown
  ): boolean;
  resolveClientEventSubscriptionsCapability(): RsProtectedResourceMetadataClientEventSubscriptionsCapability | null;
  resolveExplicitIssuer(): string | null;
  resolveHybridCapabilityOverride(): RsProtectedResourceMetadataHybridCapability | null;
  resolveLexicalCapability(): RsProtectedResourceMetadataLexicalCapability | null;
  resolvePublicUrl(req: unknown, explicit: unknown): string;
  resolveSemanticCapability():
    | RsProtectedResourceMetadataSemanticCapability
    | null
    | Promise<RsProtectedResourceMetadataSemanticCapability | null>;
  resolveSiblingPublicUrl(req: unknown, origin: string): string;
  shouldUseDirectRequestOrigin(req: unknown, explicit: unknown): boolean;
  trustedMetadataHosts: unknown;
}

export function mountRsProtectedResourceMetadata(app: AppLike, ctx: MountRsProtectedResourceMetadataContext): void {
  // Primary reference surface: RFC 9728 protected-resource metadata.
  app.get("/.well-known/oauth-protected-resource", { contract: "getProtectedResourceMetadata" }, async (req, res) => {
    if (ctx.rejectUntrustedMetadataHost(req, res, ctx.explicitResource, ctx.trustedMetadataHosts)) {
      return;
    }
    const resource = ctx.resolvePublicUrl(req, ctx.explicitResource);
    const explicitIssuer = ctx.resolveExplicitIssuer();
    const fallbackIssuer = `${req.protocol}://${req.hostname}:${ctx.asPort}`;
    const issuerUsesDirectRequestOrigin = ctx.shouldUseDirectRequestOrigin(req, explicitIssuer);
    const issuerSource = issuerUsesDirectRequestOrigin ? fallbackIssuer : explicitIssuer || fallbackIssuer;
    if (
      ctx.rejectUntrustedMetadataHost(req, res, issuerSource, ctx.trustedMetadataHosts, {
        forceHostDerived: issuerUsesDirectRequestOrigin || !explicitIssuer,
      })
    ) {
      return;
    }
    const issuer = ctx.resolvePublicUrl(req, issuerSource);

    // Composition (which capabilities to publish, which discovery hints to
    // include) is owned by the canonical `rs.protected-resource-metadata`
    // operation. The host adapter resolves URLs and live capability shapes
    // (e.g. `buildSemanticRetrievalCapability` against the live embedding
    // backend) and passes them through dependency callbacks. Truthfulness
    // rules — semantic only when backend is available; hybrid only when both
    // lexical AND semantic are supported — are encoded inside the operation.
    // See:
    //   openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md
    //   openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md
    //   openspec/changes/define-hybrid-retrieval/specs/hybrid-retrieval/spec.md
    //   openspec/changes/polish-reference-api-discovery-seams
    const { composition } = await executeRsProtectedResourceMetadata(
      {},
      {
        resolveLexicalCapability: ctx.resolveLexicalCapability,
        resolveSemanticCapability: ctx.resolveSemanticCapability,
        resolveHybridCapabilityOverride: ctx.resolveHybridCapabilityOverride,
        buildDefaultHybridCapability: ctx.buildDefaultHybridCapability,
        isHybridSuppressed: ctx.isHybridSuppressed,
        isNativeSingleSourceMode: () => ctx.nativeMode,
        // The reference implementation always mounts the
        // `/v1/event-subscriptions` routes (see buildRsApp above), so
        // we advertise the client_event_subscriptions extension
        // capability by default. Hosts that need to suppress it can
        // pass `clientEventSubscriptionsSupported: false`. See
        // openspec/changes/add-client-event-subscriptions/.
        resolveClientEventSubscriptionsCapability: ctx.resolveClientEventSubscriptionsCapability,
      }
    );
    const { capabilities, discoveryHints } = composition;

    res.json(
      ctx.buildProtectedResourceMetadata({
        resource,
        resourceName: `${ctx.providerName} Resource Server`,
        authorizationServers: [issuer],
        queryBase: `${resource}/v1`,
        providerConnectVersion: ctx.pdppProviderConnectVersion,
        selfExportSupported: true,
        tokenKindsSupported: ["owner", "client"],
        capabilities,
        discoveryHints,
        agentDiscovery: ctx.buildAgentDiscoveryMetadata(
          ctx.agentDiscoveryOrigin ? ctx.resolveSiblingPublicUrl(req, ctx.agentDiscoveryOrigin) : null,
          {
            noOwnerToken: ctx.nativeMode,
            mcpAuthorization: buildMcpAuthorizationDiscovery({ issuer, resource: `${resource}/mcp` }),
          }
        ),
        // Advisory owner-agent onboarding block. The approval origin is the
        // composed-mode browser origin rebased to the caller-visible trusted
        // public host (null in direct/ephemeral mode → block omitted). The
        // resource and issuer are the already-trusted, forwarded-origin-safe
        // values resolved above, so the block can never name an untrusted host.
        ownerAgentOnboarding: ctx.buildOwnerAgentOnboardingMetadata({
          origin: ctx.agentDiscoveryOrigin ? ctx.resolveSiblingPublicUrl(req, ctx.agentDiscoveryOrigin) : null,
          resource,
          issuer,
        }),
      })
    );
  });
}

// ─── RS `/.well-known/oauth-protected-resource/mcp` ─────────────────────────

export type MountRsMcpProtectedResourceMetadataContext = MountRsProtectedResourceMetadataContext;

export function mountRsMcpProtectedResourceMetadata(
  app: AppLike,
  ctx: MountRsMcpProtectedResourceMetadataContext
): void {
  app.get("/.well-known/oauth-protected-resource/mcp", { contract: "getMcpProtectedResourceMetadata" }, (req, res) => {
    if (ctx.rejectUntrustedMetadataHost(req, res, ctx.explicitResource, ctx.trustedMetadataHosts)) {
      return;
    }
    const resourceBase = ctx.resolvePublicUrl(req, ctx.explicitResource);
    const resource = `${resourceBase}/mcp`;
    const explicitIssuer = ctx.resolveExplicitIssuer();
    const fallbackIssuer = `${req.protocol}://${req.hostname}:${ctx.asPort}`;
    const issuerUsesDirectRequestOrigin = ctx.shouldUseDirectRequestOrigin(req, explicitIssuer);
    const issuerSource = issuerUsesDirectRequestOrigin ? fallbackIssuer : explicitIssuer || fallbackIssuer;
    if (
      ctx.rejectUntrustedMetadataHost(req, res, issuerSource, ctx.trustedMetadataHosts, {
        forceHostDerived: issuerUsesDirectRequestOrigin || !explicitIssuer,
      })
    ) {
      return;
    }
    const issuer = ctx.resolvePublicUrl(req, issuerSource);

    res.json(
      ctx.buildProtectedResourceMetadata({
        resource,
        resourceName: `${ctx.providerName} Hosted MCP Resource`,
        authorizationServers: [issuer],
        queryBase: `${resourceBase}/v1`,
        providerConnectVersion: ctx.pdppProviderConnectVersion,
        selfExportSupported: true,
        tokenKindsSupported: ["client", "mcp_package"],
        // The hosted-MCP discovery surface always advertises the MCP endpoint
        // and CLI connect target, both of which the RS itself serves — so the
        // `origin` falls back to the RS `resourceBase` in direct/ephemeral mode.
        // The docs/skill pointers (`skill`, `skill_catalog`, `llms_txt`, …) are
        // served ONLY by the composed-mode console/site origin, never the RS, so
        // their `docsOrigin` is the rebased browser origin or null — when null
        // those pointers are omitted rather than rebased onto the RS origin,
        // where they would 404. (Previously they were rebased onto the RS origin,
        // sending agents to a 404 at the very host serving `/v1/streams`.)
        agentDiscovery: ctx.buildAgentDiscoveryMetadata(
          ctx.agentDiscoveryOrigin ? ctx.resolveSiblingPublicUrl(req, ctx.agentDiscoveryOrigin) : resourceBase,
          {
            noOwnerToken: true,
            docsOrigin: ctx.agentDiscoveryOrigin ? ctx.resolveSiblingPublicUrl(req, ctx.agentDiscoveryOrigin) : null,
            mcpAuthorization: buildMcpAuthorizationDiscovery({ issuer, resource }),
          }
        ),
      })
    );
  });
}

function buildMcpAuthorizationDiscovery({ issuer, resource }: { issuer: string; resource: string }): unknown {
  return {
    authorization_code_pkce: {
      flow: "authorization_code_pkce",
      pdpp_token_kind: "client",
      authorization_endpoint: `${issuer}/oauth/authorize`,
      resource,
      resource_parameter: "required",
    },
    device_code: {
      flow: "device_code",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      pdpp_token_kind: "client",
      device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
      token_endpoint: `${issuer}/oauth/token`,
      resource,
      required_parameters: ["client_id", "resource", "authorization_details"],
      authorization_details_type: "https://pdpp.org/data-access",
      owner_bearer_accepted: false,
    },
    owner_agent_device_code: {
      flow: "device_code",
      pdpp_token_kind: "owner",
      normal_mcp_setup: false,
      advertised_in: "pdpp_owner_agent_onboarding",
      mcp_owner_bearer_rejected: true,
    },
  };
}
