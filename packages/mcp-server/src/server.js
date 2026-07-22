// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { buildResourceTemplates, buildTools, PDPP_MCP_TOOL_NAMES } from "./tools.js";
import { RsClient } from "./rs-client.js";

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
  fetch = globalThis.fetch,
  serverName = DEFAULT_SERVER_NAME,
  serverVersion = DEFAULT_SERVER_VERSION,
  serverIcons,
}) {
  // Callers may inject a custom RsClient-compatible adapter (e.g. the hosted
  // adapter's PackageRsClient fan-out). Otherwise we build a single-bearer
  // RsClient from the supplied accessToken.
  const rs = rsClient ?? new RsClient({ providerUrl, accessToken, fetch });
  const serverInfo = { name: serverName, version: serverVersion };
  if (Array.isArray(serverIcons) && serverIcons.length > 0) {
    serverInfo.icons = serverIcons;
  }
  const server = new McpServer(serverInfo, {
    instructions: PDPP_MCP_INSTRUCTIONS,
  });

  const tools = buildTools({ rs, providerUrl });
  for (const tool of tools) {
    const config = {
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
        return await tool.handler(args ?? {});
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
      async (uri, variables) => {
        return await template.read(uri.href ?? String(uri), variables);
      }
    );
  }

  return { server, rs };
}

export async function startStdioServer(options) {
  const { server } = createPdppMcpServer(options);
  const transport = new StdioServerTransport();
  const closed = new Promise((resolve) => {
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
export async function handleStreamableHttpRequest(request, options) {
  const { server } = createPdppMcpServer(options);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await Promise.allSettled([transport.close(), server.close()]);
  }
}

function toolHandlerError(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            type: "adapter_error",
            code: error?.code ?? "tool_handler_error",
            message: error?.message ?? "Tool handler threw an error",
          },
          null,
          2
        ),
      },
    ],
    structuredContent: {
      error: {
        type: "adapter_error",
        code: error?.code ?? "tool_handler_error",
        message: error?.message ?? "Tool handler threw an error",
      },
    },
  };
}

export { PDPP_MCP_TOOL_NAMES } from "./tools.js";
