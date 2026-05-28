import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { buildStreamResourceTemplate, buildTools } from './tools.js';
import { RsClient } from './rs-client.js';

export const DEFAULT_SERVER_NAME = 'pdpp-mcp-server';
export const DEFAULT_SERVER_VERSION = '0.0.0';

/**
 * Build an MCP server wired to a PDPP resource server through the supplied scoped token.
 *
 * The server registers read-only tools and one resource template. It does not
 * auto-connect to a transport — callers pass the transport explicitly so that tests
 * can use the in-memory pair and CLI use can pass StdioServerTransport.
 */
export function createPdppMcpServer({
  providerUrl,
  accessToken,
  rsClient,
  fetch = globalThis.fetch,
  serverName = DEFAULT_SERVER_NAME,
  serverVersion = DEFAULT_SERVER_VERSION,
}) {
  // Callers may inject a custom RsClient-compatible adapter (e.g. the hosted
  // adapter's PackageRsClient fan-out). Otherwise we build a single-bearer
  // RsClient from the supplied accessToken.
  const rs = rsClient ?? new RsClient({ providerUrl, accessToken, fetch });
  const server = new McpServer({ name: serverName, version: serverVersion });

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
    server.registerTool(
      tool.name,
      config,
      async (args) => {
        try {
          return await tool.handler(args ?? {});
        } catch (error) {
          return toolHandlerError(error);
        }
      }
    );
  }

  const streamTemplate = buildStreamResourceTemplate({ rs, providerUrl });
  server.registerResource(
    streamTemplate.name,
    new ResourceTemplate(streamTemplate.uriTemplate, { list: undefined }),
    {
      title: streamTemplate.title,
      description: streamTemplate.description,
      mimeType: streamTemplate.mimeType,
    },
    async (uri, variables) => {
      return await streamTemplate.read(uri.href ?? String(uri), variables);
    }
  );

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
        type: 'text',
        text: JSON.stringify(
          {
            type: 'adapter_error',
            code: error?.code ?? 'tool_handler_error',
            message: error?.message ?? 'Tool handler threw an error',
          },
          null,
          2
        ),
      },
    ],
    structuredContent: {
      error: {
        type: 'adapter_error',
        code: error?.code ?? 'tool_handler_error',
        message: error?.message ?? 'Tool handler threw an error',
      },
    },
  };
}
