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
  // Optional public connection identity. Forwarded verbatim to the RS so
  // the resource server enforces grant scope; the MCP layer never invents
  // or rewrites a connection_id. See:
  //   openspec/changes/expose-connection-identity-on-public-read
  'connection_id',
  // Deprecated wire alias for `connection_id`. Forwarded unchanged so a
  // pre-migration client can still address a specific connection while
  // downstream consumers adopt the canonical field.
  'connector_instance_id',
]);

const CONNECTION_ID_DESCRIPTION =
  'Optional connection_id from a prior list_streams response. Omit to fan in across every connection your grant authorizes for the named stream; pass it to scope the call to one account/device/profile. Required to recover from a typed `ambiguous_connection` (409) error returned by `fetch` or `fetch_blob` — the error envelope lists the candidate `available_connections` and instructs you to retry with `connection_id`.';

const CONNECTOR_INSTANCE_ID_DESCRIPTION =
  'Deprecated wire alias for `connection_id`. Forwarded for pre-migration clients; prefer `connection_id`.';

const EMPTY_TOOL_INPUT_SCHEMA = z.object({}).strict();

const ConnectionIdInputShape = {
  connection_id: z.string().min(1).describe(CONNECTION_ID_DESCRIPTION).optional(),
  connector_instance_id: z
    .string()
    .min(1)
    .describe(CONNECTOR_INSTANCE_ID_DESCRIPTION)
    .optional(),
};

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
        'List streams the configured scoped grant can read. Calls GET /v1/streams. ' +
        'Multi-connection deployments return one entry per (stream, connection_id); ' +
        'each entry carries `connection_id` and an owner-meaningful `display_name`. ' +
        'Pass an optional `connection_id` to restrict the listing to a single ' +
        'connection. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z.object(ConnectionIdInputShape).strict(),
      handler: async (args) => {
        const query = pickQuery(args, SUPPORTED_QUERY_KEYS);
        const response = await rs.getJson('/v1/streams', { query });
        return toToolResult(response, providerUrl);
      },
    },
    {
      name: 'query_records',
      title: 'Query PDPP records',
      description:
        'Query records in a stream by forwarding supported query parameters to ' +
        'GET /v1/streams/{stream}/records. Supported params: limit, cursor, order, ' +
        'filter, fields, view, expand, expand_limit, changes_since, connection_id ' +
        '(plus the deprecated connector_instance_id alias). Omitting connection_id ' +
        'on a multi-connection grant fans in across granted connections; each ' +
        'record carries connection_id so the caller can attribute it. Read-only.',
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
          ...ConnectionIdInputShape,
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
        'search envelope plus ChatGPT-compatible structuredContent.results. Accepts ' +
        'an optional connection_id (with deprecated connector_instance_id alias); ' +
        'omitted, hits fan in across granted connections and each hit carries ' +
        'connection_id and display_name. If the deployment does not advertise ' +
        'search, the RS error envelope is preserved in the tool result. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          q: z.string().min(1).describe('Search query string.'),
          streams: z.array(z.string()).optional(),
          limit: z.number().int().positive().max(200).optional(),
          cursor: z.string().optional(),
          mode: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
          ...ConnectionIdInputShape,
        })
        .strict(),
      handler: async (args) => {
        const query = {
          q: args.q,
          streams: args.streams,
          limit: args.limit,
          cursor: args.cursor,
          mode: args.mode,
          connection_id: args.connection_id,
          connector_instance_id: args.connector_instance_id,
        };
        const response = await rs.getJson('/v1/search', { query });
        return toSearchToolResult(response, providerUrl);
      },
    },
    {
      name: 'fetch',
      title: 'Fetch PDPP search result',
      description:
        'Fetch a single ChatGPT-compatible document by a result id returned from search. ' +
        'The default id format is stream:record_id and is read through ' +
        'GET /v1/streams/{stream}/records/{record_id}. When the identifier resolves to ' +
        'more than one connection under your grant and connection_id is omitted, the ' +
        'RS returns a typed ambiguous_connection (409) error listing ' +
        '`available_connections`; retry with the chosen connection_id. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          id: z.string().min(1).describe('Search result id, usually stream:record_id.'),
          ...ConnectionIdInputShape,
        })
        .strict(),
      handler: async (args) => {
        const ref = parseRecordResultId(args.id);
        const query = pickQuery(args, SUPPORTED_QUERY_KEYS);
        const response = await rs.getJson(
          `/v1/streams/${encodeURIComponent(ref.stream)}/records/${encodeURIComponent(ref.recordId)}`,
          { query }
        );
        return toFetchToolResult(response, providerUrl, args.id);
      },
    },
    {
      name: 'fetch_blob',
      title: 'Fetch PDPP blob',
      description:
        'Fetch a blob referenced by a prior authorized record via GET /v1/blobs/{blob_id} ' +
        'using the configured scoped token. Returns base64 bytes and the RS-reported mime ' +
        'type. When the blob identifier resolves to more than one connection under your ' +
        'grant and connection_id is omitted, the RS returns a typed ambiguous_connection ' +
        '(409) error listing `available_connections`; retry with the chosen connection_id. ' +
        'Read-only.',
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
          ...ConnectionIdInputShape,
        })
        .strict(),
      handler: async (args) => {
        const blobId = requireSafeName(args.blob_id, 'blob_id');
        const headers = args.range ? { Range: args.range } : undefined;
        const query = pickQuery(args, SUPPORTED_QUERY_KEYS);
        const response = await rs.getRaw(`/v1/blobs/${encodeURIComponent(blobId)}`, {
          headers,
          query,
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

function toSearchToolResult(response, providerUrl) {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const results = normalizeSearchResults(response.body);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ...response.body, results }, null, 2),
      },
    ],
    structuredContent: {
      data: response.body,
      results,
      provider_url: providerUrl,
      request_id: response.requestId,
    },
  };
}

function toFetchToolResult(response, providerUrl, requestedId) {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const document = normalizeFetchedDocument(response.body, requestedId, providerUrl);
  return {
    content: [
      {
        type: 'text',
        text: document.text,
      },
    ],
    structuredContent: {
      ...document,
      data: response.body,
      provider_url: providerUrl,
      request_id: response.requestId,
    },
  };
}

function normalizeSearchResults(body) {
  const candidates = Array.isArray(body?.results)
    ? body.results
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.hits)
        ? body.hits
        : [];
  return candidates.map((hit, index) => {
    const id = resultIdForHit(hit, index);
    return {
      id,
      title: titleForRecord(hit, id),
      url: urlForRecord(hit, id),
    };
  });
}

function resultIdForHit(hit, index) {
  const directId = stringValue(hit?.result_id ?? hit?.resultId);
  if (directId) return directId;

  const stream = stringValue(hit?.stream ?? hit?.stream_name ?? hit?.streamName);
  const recordId = stringValue(hit?.id ?? hit?.record_id ?? hit?.recordId ?? hit?.record_key ?? hit?.recordKey);
  if (stream && recordId) {
    return `${stream}:${recordId}`;
  }

  const fallback = stringValue(hit?.id ?? hit?.url);
  return fallback || `result:${index + 1}`;
}

function parseRecordResultId(id) {
  const value = requireSafeName(id, 'id');
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('id must use stream:record_id format');
  }
  return {
    stream: requireSafeName(value.slice(0, separator), 'stream'),
    recordId: requireSafeName(value.slice(separator + 1), 'record_id'),
  };
}

function normalizeFetchedDocument(record, requestedId, providerUrl) {
  const id = stringValue(record?.id ?? record?.record_id ?? record?.recordId) || requestedId;
  const stream = stringValue(record?.stream ?? record?.stream_name ?? record?.streamName);
  const resultId = stream && id && !requestedId.includes(':') ? `${stream}:${id}` : requestedId;
  const title = titleForRecord(record, resultId);
  const text = textForRecord(record);
  const url = urlForRecord(record, resultId, providerUrl);
  const metadata = metadataForRecord(record, { id: resultId, title, url });
  return { id: resultId, title, text, url, metadata };
}

function titleForRecord(record, fallbackId) {
  return (
    stringValue(record?.title) ||
    stringValue(record?.name) ||
    stringValue(record?.subject) ||
    stringValue(record?.snippet?.text) ||
    stringValue(record?.summary) ||
    fallbackId
  );
}

function textForRecord(record) {
  return (
    stringValue(record?.text) ||
    stringValue(record?.content) ||
    stringValue(record?.body) ||
    stringValue(record?.summary) ||
    JSON.stringify(record, null, 2)
  );
}

function urlForRecord(record, fallbackId, providerUrl) {
  const directUrl = stringValue(record?.url ?? record?.record_url ?? record?.recordUrl ?? record?.href ?? record?.source_url ?? record?.sourceUrl);
  if (directUrl) return directUrl;
  if (providerUrl && fallbackId) {
    const recordRef = parseRecordResultIdOrNull(fallbackId);
    if (recordRef) {
      const base = providerUrl.replace(/\/$/, '');
      return `${base}/v1/streams/${encodeURIComponent(recordRef.stream)}/records/${encodeURIComponent(recordRef.recordId)}`;
    }
  }
  return `pdpp://record/${encodeURIComponent(fallbackId)}`;
}

function parseRecordResultIdOrNull(id) {
  try {
    return parseRecordResultId(id);
  } catch {
    return null;
  }
}

function metadataForRecord(record, omitted) {
  if (!record || typeof record !== 'object') {
    return {};
  }
  const metadata = record.metadata && typeof record.metadata === 'object' ? { ...record.metadata } : {};
  for (const [key, value] of Object.entries(record)) {
    if (['metadata', 'text', 'content', 'body'].includes(key)) continue;
    if (Object.values(omitted).includes(value)) continue;
    metadata[key] = value;
  }
  return metadata;
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

export const __internal = {
  requireSafeName,
  pickQuery,
  toToolResult,
  toBlobToolResult,
  toSearchToolResult,
  toFetchToolResult,
  resolveStreamName,
};
