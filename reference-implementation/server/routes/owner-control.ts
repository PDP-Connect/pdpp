// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the bearer-authed owner-agent control entrypoint route
// `GET /v1/owner/control`.
//
// This is the durable, non-secret discovery surface a trusted owner agent
// (Daisy/Simon-style local automation) reads before guessing at owner-control
// routes. It returns a capability document that names every owner-agent
// control action family, marks which are `supported` (with method + absolute
// URL) vs `owner_mediated` / `unsupported` in this build, and links to the
// already-supported owner-agent routes — especially `GET /v1/owner/connections`.
//
// It is the `/v1/owner/*` sibling of the cookie-authed `/_ref/*` surface and
// reuses the existing owner-bearer guards (`requireToken` + `requireOwner`)
// without teaching `requireOwnerSession` (cookie) a second identity source.
// `/mcp` owner-bearer rejection (`requireClientOrMcpPackage`) is untouched.
//
// The action-family catalog is NOT defined here. It is projected from
// `buildOwnerAgentControlSurface` in `server/metadata.ts`, the same builder
// that feeds the advisory `pdpp_owner_agent_onboarding.control_surface`
// discovery hint, so the live document and the discovery metadata can never
// disagree about what is supported.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent credentials SHALL authorize an explicit owner REST
//         control surface" → "Trusted owner agent discovers control capabilities")

import type { OwnerAgentControlSurface } from "../metadata.ts";
import type { MiddlewareHandler, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/owner-connections.ts`.

interface RouteRequest {
  get(name: string): string | undefined;
  readonly hostname: string;
  readonly protocol: string;
}

interface RouteResponse {
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

export interface MountOwnerControlContext {
  // Projects the owner-agent control-surface capability document from the
  // resolved, forwarded-origin-safe RS public base. Same builder the discovery
  // metadata uses.
  buildOwnerAgentControlSurface(args: { resource: string }): OwnerAgentControlSurface;
  handleError(res: unknown, err: unknown): void;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  // Resolves the caller-visible trusted RS public base for this request, using
  // the same forwarded-origin handling as the metadata routes so the catalog's
  // URLs match the advertised resource exactly.
  resolveResource(req: unknown): string;
}

// GET /v1/owner/control — bearer-authed owner-agent control capability
// document. Auth: owner bearer (`pdpp_token_kind: "owner"`). Client and
// `mcp_package` bearers are rejected with 403 by `requireOwner`; a missing
// bearer is rejected with 401 by `requireToken`.
export function mountOwnerControl(app: AppLike, ctx: MountOwnerControlContext): void {
  app.get(
    "/v1/owner/control",
    { contract: "ownerControlCapabilities" },
    ctx.requireToken,
    ctx.requireOwner,
    (req: RouteRequest, res: RouteResponse) => {
      try {
        const resource = ctx.resolveResource(req);
        res.json(ctx.buildOwnerAgentControlSurface({ resource }));
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}
