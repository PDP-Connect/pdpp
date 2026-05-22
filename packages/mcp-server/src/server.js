import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildStreamResourceTemplate, buildTools } from './tools.js';
import { RsClient } from './rs-client.js';

export const DEFAULT_SERVER_NAME = 'pdpp-mcp-server';
export const DEFAULT_SERVER_VERSION = '0.0.0';

/**
 * Build an MCP server wired to a PDPP resource server through the supplied scoped token.
 *
 * The server registers exactly five read-only tools and one resource template. It does
 * not auto-connect to a transport — callers pass the transport explicitly so that tests
 * can use the in-memory pair and CLI use can pass StdioServerTransport.
 */
export function createPdppMcpServer({
  providerUrl,
  accessToken,
  fetch = globalThis.fetch,
  serverName = DEFAULT_SERVER_NAME,
  serverVersion = DEFAULT_SERVER_VERSION,
}) {
  const rs = new RsClient({ providerUrl, accessToken, fetch });
  const server = new McpServer({ name: serverName, version: serverVersion });

  const tools = buildTools({ rs, providerUrl });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: tool.inputSchema,
      },
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
