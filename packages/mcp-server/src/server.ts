// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { RsClient } from "./rs-client.ts";
import { buildResourceTemplates, buildTools } from "./tools.ts";

export const DEFAULT_SERVER_NAME = "pdpp-mcp-server";
export const DEFAULT_SERVER_VERSION = "0.0.0";

// Shared MCP server instructions. The first 512 characters must be
// self-contained for ChatGPT and Codex (OpenAI Apps SDK guidance).
// Cross-tool details that would otherwise repeat across tool descriptions live
// here; tool descriptions stay concise and routing-specific.
export const PDPP_MCP_INSTRUCTIONS =
  "PDPP tools are grant-scoped. Start with `schema`, then call `schema(stream)` after choosing a stream; add `connection_id` when a stream name appears under multiple sources or before full schema. Use `connection_id` from schema results or `available_connections` errors to disambiguate sources. Filters must be typed objects, not bracket strings. Page and narrow with `limit`, `cursor`, and `fields`; prefer `aggregate` or lexical `search` for exact terms. " +
  "The configured bearer limits every result; do not use owner or control-plane tokens for normal MCP access. Schema advertises valid fields, filter operators, expand relations, sort/count support, connection identities, and connector keys. Persist `connection_id`, not `grant_id`, across reconnects. Search result ids are self-contained handles; pass them to `fetch` for projected records or to `read_record_field` for bounded field windows. " +
  "When a preview is not enough, follow `structuredContent.content_ladder`: call `read_record_field` with the supplied arguments. Resource-aware hosts may also read hidden/returned resource URIs, but generic resource reads are not required for ordinary text evidence. " +
  "`content[]` is the reliable model-visible guide and includes next cursors/bookmarks when present; `structuredContent` is a host-dependent machine envelope, not the only place to find next-step handles.";

interface ServerIcon {
  mimeType?: string;
  sizes?: string[];
  src: string;
}

interface CreatePdppMcpServerOptions {
  accessToken: string;
  fetch?: typeof fetch;
  providerUrl: string;
  rsClient?: RsClient;
  serverIcons?: ServerIcon[];
  serverName?: string;
  serverVersion?: string;
}

/**
 * Build an MCP server wired to a PDPP resource server through the supplied scoped token.
 *
 * The server registers the profile-free normal PDPP read surface plus one resource
 * template. It does not auto-connect to a transport — callers pass the transport
 * explicitly so tests can use the in-memory pair and CLI use can pass
 * StdioServerTransport.
 */
export function createPdppMcpServer({
  providerUrl,
  accessToken,
  rsClient,
  fetch: fetchImpl = globalThis.fetch,
  serverName = DEFAULT_SERVER_NAME,
  serverVersion = DEFAULT_SERVER_VERSION,
  serverIcons,
}: CreatePdppMcpServerOptions): { server: McpServer; rs: RsClient } {
  // Callers may inject a custom RsClient-compatible adapter (e.g. the hosted
  // adapter's PackageRsClient fan-out). Otherwise we build a single-bearer
  // RsClient from the supplied accessToken.
  const rs = rsClient ?? new RsClient({ providerUrl, accessToken, fetch: fetchImpl });
  const serverInfo: { name: string; version: string; icons?: ServerIcon[] } = {
    name: serverName,
    version: serverVersion,
  };
  if (Array.isArray(serverIcons) && serverIcons.length > 0) {
    serverInfo.icons = serverIcons;
  }
  const server = new McpServer(serverInfo, {
    instructions: PDPP_MCP_INSTRUCTIONS,
  });

  const tools = buildTools({ rs, providerUrl });
  for (const tool of tools) {
    const config: {
      title: string;
      description: string;
      annotations: typeof tool.annotations;
      inputSchema: typeof tool.inputSchema;
      outputSchema?: typeof tool.outputSchema;
    } = {
      title: tool.title,
      description: tool.description,
      annotations: tool.annotations,
      inputSchema: tool.inputSchema,
    };
    if (tool.outputSchema) {
      config.outputSchema = tool.outputSchema;
    }
    server.registerTool(tool.name, config, async (args) => {
      try {
        return await tool.handler((args ?? {}) as Record<string, unknown>);
      } catch (error) {
        return toolHandlerError(error);
      }
    });
  }

  for (const template of buildResourceTemplates({ rs, providerUrl })) {
    server.registerResource(
      template.name,
      new ResourceTemplate(template.uriTemplate, { list: undefined }),
      {
        title: template.title,
        description: template.description,
        mimeType: template.mimeType,
      },
      async (uri, variables) => await template.read(uri.href ?? String(uri), variables)
    );
  }

  return { server, rs };
}

export interface StdioServerHandle {
  closed: Promise<void>;
  server: McpServer;
  transport: StdioServerTransport;
}

export async function startStdioServer(options: CreatePdppMcpServerOptions): Promise<StdioServerHandle> {
  const { server } = createPdppMcpServer(options);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    const prior = transport.onclose;
    transport.onclose = () => {
      try {
        prior?.();
      } finally {
        resolve();
      }
    };
  });
  await server.connect(transport);
  return { server, transport, closed };
}

/**
 * Handle one hosted MCP Streamable HTTP request in stateless mode.
 *
 * The caller owns authentication and should pass an already-authorized scoped client
 * bearer as accessToken. A fresh MCP server and transport are created per request so
 * authorization state is never cached in an MCP session.
 */
export async function handleStreamableHttpRequest(
  request: Request,
  options: CreatePdppMcpServerOptions
): Promise<Response> {
  const { server } = createPdppMcpServer(options);
  // Explicitly omitting `sessionIdGenerator` (rather than setting it to
  // `undefined`) selects the SDK's stateless mode identically —
  // `exactOptionalPropertyTypes` rejects an explicit `undefined` here even
  // though the SDK's own docs recommend it for this exact case.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await Promise.allSettled([transport.close(), server.close()]);
  }
}

// Kept as a `type` (not `interface`) on purpose — returned from the tool
// handler passed to the MCP SDK's `registerTool`, whose callback return type
// carries an index signature only a structurally-open `type` alias
// satisfies.
// biome-ignore lint/style/useConsistentTypeDefinitions: see comment above.
type ToolHandlerErrorEnvelope = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  structuredContent: {
    error: { type: string; code: string; message: string };
  };
};

function toolHandlerError(error: unknown): ToolHandlerErrorEnvelope {
  const err = error as { code?: unknown; message?: unknown } | null;
  const code = typeof err?.code === "string" ? err.code : "tool_handler_error";
  const message = typeof err?.message === "string" ? err.message : "Tool handler threw an error";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            type: "adapter_error",
            code,
            message,
          },
          null,
          2
        ),
      },
    ],
    structuredContent: {
      error: {
        type: "adapter_error",
        code,
        message,
      },
    },
  };
}

export { PDPP_MCP_TOOL_NAMES } from "./tools.ts";
