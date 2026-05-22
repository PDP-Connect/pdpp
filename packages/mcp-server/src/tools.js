import { z } from 'zod';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const SUPPORTED_QUERY_KEYS = new Set([
  'limit',
  'cursor',
  'order',
  'filter',
  'fields',
  'view',
  'expand',
  'expand_limit',
  'changes_since',
]);

const EMPTY_TOOL_INPUT_SCHEMA = z.object({}).strict();

/**
 * Build the static tool definitions. Descriptions are constant — they are never derived
 * from manifest, stream, or record data. RS payloads are returned as data; nothing is
 * interpolated into instructions to the model.
 */
export function buildTools({ rs, providerUrl }) {
  return [
    {
      name: 'schema',
      title: 'Get PDPP schema',
      description:
        'Return the grant-scoped PDPP schema document from GET /v1/schema. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: EMPTY_TOOL_INPUT_SCHEMA,
      handler: async () => {
        const response = await rs.getJson('/v1/schema');
        return toToolResult(response, providerUrl);
      },
    },
    {
      name: 'list_streams',
      title: 'List PDPP streams',
      description:
        'List streams the configured scoped grant can read. Calls GET /v1/streams. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: EMPTY_TOOL_INPUT_SCHEMA,
      handler: async () => {
        const response = await rs.getJson('/v1/streams');
        return toToolResult(response, providerUrl);
      },
    },
    {
      name: 'query_records',
      title: 'Query PDPP records',
      description:
        'Query records in a stream by forwarding supported query parameters to ' +
        'GET /v1/streams/{stream}/records. Supported params: limit, cursor, order, ' +
        'filter, fields, view, expand, expand_limit, changes_since. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          stream: z.string().min(1).describe('Stream name as returned by list_streams.'),
          limit: z.number().int().positive().max(1000).optional(),
          cursor: z.string().optional(),
          order: z.string().optional(),
          filter: z.string().optional(),
          fields: z.array(z.string()).optional(),
          view: z.string().optional(),
          expand: z.array(z.string()).optional(),
          expand_limit: z.number().int().positive().max(100).optional(),
          changes_since: z.string().optional(),
        })
        .strict(),
      handler: async (args) => {
        const stream = requireSafeName(args?.stream, 'stream');
        const query = pickQuery(args, SUPPORTED_QUERY_KEYS);
        const response = await rs.getJson(`/v1/streams/${encodeURIComponent(stream)}/records`, {
          query,
        });
        return toToolResult(response, providerUrl);
      },
    },
    {
      name: 'search',
      title: 'Search PDPP records',
      description:
        'Search records via GET /v1/search using the scoped grant. Returns the RS ' +
        'search envelope verbatim. If the deployment does not advertise search, the RS ' +
        'error envelope is preserved in the tool result. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          q: z.string().min(1).describe('Search query string.'),
          streams: z.array(z.string()).optional(),
          limit: z.number().int().positive().max(200).optional(),
          cursor: z.string().optional(),
          mode: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
        })
        .strict(),
      handler: async (args) => {
        const query = {
          q: args.q,
          streams: args.streams,
          limit: args.limit,
          cursor: args.cursor,
          mode: args.mode,
        };
        const response = await rs.getJson('/v1/search', { query });
        return toToolResult(response, providerUrl);
      },
    },
    {
      name: 'fetch_blob',
      title: 'Fetch PDPP blob',
      description:
        'Fetch a blob referenced by a prior authorized record via GET /v1/blobs/{blob_id} ' +
        'using the configured scoped token. Returns base64 bytes and the RS-reported mime ' +
        'type. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          blob_id: z
            .string()
            .min(1)
            .describe('Blob identifier returned by a previous query_records or search call.'),
          range: z
            .string()
            .regex(/^bytes=\d+-\d*$/, { message: 'range must look like bytes=0-1023' })
            .optional(),
        })
        .strict(),
      handler: async (args) => {
        const blobId = requireSafeName(args.blob_id, 'blob_id');
        const headers = args.range ? { Range: args.range } : undefined;
        const response = await rs.getRaw(`/v1/blobs/${encodeURIComponent(blobId)}`, {
          headers,
        });
        return toBlobToolResult(response, providerUrl);
      },
    },
  ];
}

export function buildStreamResourceTemplate({ rs, providerUrl }) {
  return {
    uriTemplate: 'pdpp://stream/{name}',
    name: 'pdpp-stream',
    title: 'PDPP stream metadata',
    description:
      'Returns the stream metadata document for a single stream (GET /v1/streams/{name}). Read-only.',
    mimeType: 'application/json',
    read: async (uri, variables) => {
      const streamName = resolveStreamName(uri, variables);
      const response = await rs.getJson(`/v1/streams/${encodeURIComponent(streamName)}`);
      if (response.ok) {
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(response.body, null, 2),
            },
          ],
        };
      }
      const error = response.error ?? { type: 'rs_error', code: 'unknown', message: 'Unknown RS error' };
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ error, provider_url: providerUrl, http_status: response.status }, null, 2),
          },
        ],
      };
    },
  };
}

function resolveStreamName(uri, variables) {
  const rawFromVariables = variables?.name;
  if (typeof rawFromVariables === 'string' && rawFromVariables.length > 0) {
    return requireSafeName(decodeIfEncoded(rawFromVariables), 'stream');
  }
  const match = /^pdpp:\/\/stream\/([^/]+)$/.exec(uri);
  if (!match) {
    throw new InvalidResourceUriError(`Resource URI ${uri} does not match pdpp://stream/{name}.`);
  }
  return requireSafeName(decodeURIComponent(match[1]), 'stream');
}

function decodeIfEncoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class InvalidResourceUriError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidResourceUriError';
  }
}

function requireSafeName(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  // Reject path-traversal and slash-bearing inputs. The RS validates names too, but a
  // defensive check here keeps the resource template URI surface narrow.
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.includes('..')) {
    throw new Error(`${label} contains invalid characters`);
  }
  return value;
}

function pickQuery(args, supportedKeys) {
  if (!args || typeof args !== 'object') {
    return {};
  }
  const out = {};
  for (const key of Object.keys(args)) {
    if (key === 'stream') continue;
    if (!supportedKeys.has(key)) continue;
    out[key] = args[key];
  }
  return out;
}

function toToolResult(response, providerUrl) {
  if (response.ok) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.body, null, 2),
        },
      ],
      structuredContent: { data: response.body, provider_url: providerUrl, request_id: response.requestId },
    };
  }
  return errorToolResult(response, providerUrl);
}

function toBlobToolResult(response, providerUrl) {
  if (response.ok) {
    const base64 = Buffer.isBuffer(response.body) ? response.body.toString('base64') : '';
    return {
      content: [
        {
          type: 'text',
          text: `Fetched ${response.body.length} bytes (${response.contentType || 'application/octet-stream'}).`,
        },
      ],
      structuredContent: {
        provider_url: providerUrl,
        request_id: response.requestId,
        bytes_base64: base64,
        mime_type: response.contentType || 'application/octet-stream',
        size: response.body.length,
      },
    };
  }
  return errorToolResult(response, providerUrl);
}

function errorToolResult(response, providerUrl) {
  const error = response.error ?? {
    type: 'rs_error',
    code: `http_${response.status}`,
    message: `Resource server returned HTTP ${response.status}`,
  };
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(error, null, 2),
      },
    ],
    structuredContent: {
      error,
      provider_url: providerUrl,
      http_status: response.status,
      request_id: response.requestId,
    },
  };
}

export const __internal = { requireSafeName, pickQuery, toToolResult, toBlobToolResult, resolveStreamName };
