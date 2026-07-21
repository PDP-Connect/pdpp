// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the CIMD (Client ID Metadata Document) service route.
//
// Serves operator-created CIMD documents at
//   GET /oauth/client-metadata/:id
//
// These let local MCP clients (Claude Code, Codex) use a stable PDPP-hosted
// URL as their client_id without hosting their own HTTPS metadata endpoint.
//
// See openspec/changes/add-mcp-cimd-client-identity/design.md §Client metadata
// document service at /oauth/client-metadata/:id.

interface RouteRequest {
  get(name: string): string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly hostname: string;
  readonly params: Record<string, string>;
  readonly protocol: string;
}

interface RouteResponse {
  json(body: unknown): unknown;
  setHeader(name: string, value: string): RouteResponse;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

interface AppLike {
  get(path: string, ...args: unknown[]): AppLike;
}

export interface MountClientMetadataContext {
  explicitIssuer: string | null;
  /** Fetch an operator-created CIMD document by its ID, or null if not found. */
  getCimdDocument(id: string): Promise<{
    document_id: string;
    client_name: string | null;
    redirect_uris: string[];
    logo_uri: string | null;
    created_at: string;
    updated_at: string;
  } | null>;
  /** Resolve the public base URL for this AS (e.g. https://pdpp.example.com). */
  resolvePublicUrl(req: RouteRequest, explicit: unknown): string;
}

export function mountClientMetadata(app: AppLike, ctx: MountClientMetadataContext): void {
  const handler: RouteHandler = async (req, res): Promise<void> => {
    const documentId = req.params.id;
    if (!documentId || typeof documentId !== "string") {
      res.status(404).json({ error: "not_found", error_description: "Unknown client metadata document" });
      return;
    }

    const doc = await ctx.getCimdDocument(documentId);
    if (!doc) {
      res.status(404).json({ error: "not_found", error_description: "Unknown client metadata document" });
      return;
    }

    // Build the self-referential client_id URL
    const issuer = ctx.resolvePublicUrl(req, ctx.explicitIssuer);
    const clientId = `${issuer}/oauth/client-metadata/${doc.document_id}`;

    const document = {
      client_id: clientId,
      client_name: doc.client_name || undefined,
      logo_uri: doc.logo_uri || undefined,
      redirect_uris: doc.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    };

    // Strip undefined fields for clean JSON output
    const clean = Object.fromEntries(Object.entries(document).filter(([, v]) => v !== undefined));

    (res as RouteResponse).setHeader("Content-Type", "application/json").setHeader("Cache-Control", "max-age=3600");
    res.status(200).json(clean);
  };

  (app as AppLike).get("/oauth/client-metadata/:id", handler as unknown);
}
