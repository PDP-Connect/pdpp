import { z } from 'zod';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Mirror of the REST public read query-param vocabulary. Forwarded verbatim
// to the RS; the MCP layer never silently drops a member. `sort` and `count`
// are canonical public read primitives advertised by `GET /v1/schema`; the
// reference RS does not implement them yet and will return a typed
// `unsupported_query` (400) error when they are forwarded. That is the
// honest mirror posture defined by
//   openspec/changes/canonicalize-public-read-contract
// (5.1 MCP input schemas mirror canonical args; 5.4 MCP does not silently
// drop unsupported arguments that REST would reject).
const SUPPORTED_QUERY_KEYS = new Set([
  'limit',
  'cursor',
  'order',
  'sort',
  'count',
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
  'Optional connection_id from a prior list_streams response. Omit to fan in across every connection your grant authorizes for the named stream; pass it to scope the call to one account/device/profile. Required to recover from a typed `ambiguous_connection` (409) error returned by `fetch` or `fetch_blob` — the error envelope lists the candidate `available_connections` and instructs you to retry with `connection_id`. Granted connection identities are advertised by `GET /v1/schema`.';

const CONNECTOR_INSTANCE_ID_DESCRIPTION =
  'Deprecated wire alias for `connection_id`. Accepted only for pre-migration compatibility — new clients SHOULD pass `connection_id` instead and ignore this field on the response.';

const FIELDS_DESCRIPTION =
  'Field allowlist for projection. Field paths must be declared by the stream; advertised by `GET /v1/schema` (`field_capabilities`). Unknown paths are rejected by the RS rather than silently widened.';

const FILTER_DESCRIPTION =
  'Per-field filter spec, URL-encoded as `filter[field]=value` (exact) or `filter[field][op]=value` (operator). Allowed fields and operators are advertised by `GET /v1/schema` (`field_capabilities`); unsupported fields or operators are rejected by the RS rather than silently ignored. Forwarded verbatim — MCP does not parse the filter shape.';

const EXPAND_DESCRIPTION =
  'One-hop inline expansion list. Each entry is a manifest-declared parent-to-child relation. Expandable relations and per-relation `expand_limit` caps are advertised by `GET /v1/schema` (`expand_capabilities`); unadvertised relations are rejected by the RS.';

const EXPAND_LIMIT_DESCRIPTION =
  'Per-relation cap for has-many expansion, keyed by relation name. The RS clamps to the per-relation `max_limit` advertised by `GET /v1/schema`.';

const ORDER_DESCRIPTION =
  "Page order for the cursor-based pagination primitive: `asc` or `desc`. This is the reference runtime's spelling; the canonical `sort=-field` sign-prefix vocabulary is advertised by `GET /v1/schema` but not yet implemented by the runtime — forwarding `sort` will currently return a typed `unsupported_query` 400.";

const SORT_DESCRIPTION =
  'Canonical sign-prefix sort spec advertised by `GET /v1/schema` (e.g. `sort=-emitted_at,name`). The reference runtime does not yet implement `sort` and will reject it with a typed `unsupported_query` 400; use `order=asc|desc` until `/v1/schema` advertises sortable fields. Forwarded verbatim so MCP does not silently drop a parameter REST would reject.';

const COUNT_DESCRIPTION =
  'Canonical opt-in count grade (`none`, `estimated`, `exact`) advertised by `GET /v1/schema`. The reference runtime does not yet implement counts and will reject with a typed `unsupported_query` 400 if forwarded; consult `/v1/schema` for count support. Forwarded verbatim so MCP does not silently drop a parameter REST would reject.';

const EMPTY_TOOL_INPUT_SCHEMA = z.object({}).strict();

const ConnectionIdInputShape = {
  connection_id: z.string().min(1).describe(CONNECTION_ID_DESCRIPTION).optional(),
  connector_instance_id: z
    .string()
    .min(1)
    .describe(CONNECTOR_INSTANCE_ID_DESCRIPTION)
    .optional(),
};

// Canonical envelope summary referenced from tool descriptions. Kept terse to
// stay within MCP token-budget norms; the authoritative schema vocabulary
// lives at `GET /v1/schema` and in the OpenAPI artifacts published by the
// reference-contract package.
const CANONICAL_SCHEMA_HINT =
  'Per-stream filter operators, expandable relations, projection support, search modes, and count support are advertised by `GET /v1/schema`. Consult it before constructing filter, sort, expand, fields, or count arguments.';

// outputSchema describes the MCP wrapper around the RS response body. We do
// NOT bake the RS body shape into the outputSchema because the canonical
// envelope is the contract source of truth and the RS still ships legacy
// envelopes during the migration window. Validating `data` as a generic
// object keeps the MCP wrapper honest without over-promising RS structure.
const READ_OUTPUT_SCHEMA_SHAPE = {
  data: z
    .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .describe(
      'Canonical RS response body. Follows the public read envelope advertised by `GET /v1/schema` plus operation-specific extensions.',
    ),
  provider_url: z.string().describe('RS base URL the MCP server was configured with.'),
  request_id: z.string().nullable().describe('RS x-request-id when present.'),
};

const SEARCH_OUTPUT_SCHEMA_SHAPE = {
  ...READ_OUTPUT_SCHEMA_SHAPE,
  results: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        url: z.string(),
      }).passthrough(),
    )
    .describe(
      'ChatGPT-compatible flattened search results. Each entry carries `id` (default `stream:record_id`), `title`, and `url`. Use `data` for the full canonical envelope.',
    ),
};

const FETCH_OUTPUT_SCHEMA_SHAPE = {
  ...READ_OUTPUT_SCHEMA_SHAPE,
  id: z.string(),
  title: z.string(),
  text: z.string(),
  url: z.string(),
  metadata: z.record(z.string(), z.unknown()),
};

const BLOB_OUTPUT_SCHEMA_SHAPE = {
  provider_url: z.string(),
  request_id: z.string().nullable(),
  bytes_base64: z.string(),
  mime_type: z.string(),
  size: z.number().int().nonnegative(),
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
        'Return the grant-scoped PDPP schema document from `GET /v1/schema`. This is the canonical capability source: streams, per-field filter operators (`field_capabilities`), expandable relations (`expand_capabilities`), projection support, search modes, pagination support, count support, and granted connection identities (`connection_id`, `display_name`). Call this first to discover what filter, sort, expand, fields, or count arguments are valid before issuing other tools. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: EMPTY_TOOL_INPUT_SCHEMA,
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async () => {
        const response = await rs.getJson('/v1/schema');
        return toToolResult(response, providerUrl, 'PDPP schema');
      },
    },
    {
      name: 'list_streams',
      title: 'List PDPP streams',
      description:
        'List streams the configured scoped grant can read via `GET /v1/streams`. Multi-connection deployments emit one entry per `(stream, connection_id)`; each entry carries `connection_id` and `display_name`. Pass `connection_id` to restrict to a single connection. ' +
        CANONICAL_SCHEMA_HINT +
        ' Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z.object(ConnectionIdInputShape).strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const query = pickQuery(args, SUPPORTED_QUERY_KEYS);
        const response = await rs.getJson('/v1/streams', { query });
        return toToolResult(response, providerUrl, 'PDPP streams');
      },
    },
    {
      name: 'query_records',
      title: 'Query PDPP records',
      description:
        'Query records in a stream via `GET /v1/streams/{stream}/records`. Forwards canonical public read args verbatim — MCP does not silently drop a parameter the RS would reject. Omitting `connection_id` on a multi-connection grant fans in across granted connections; each record carries `connection_id` for attribution. ' +
        CANONICAL_SCHEMA_HINT +
        ' Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          stream: z.string().min(1).describe('Stream name as returned by `list_streams`.'),
          limit: z.number().int().positive().max(1000).optional(),
          cursor: z.string().optional(),
          order: z.string().optional().describe(ORDER_DESCRIPTION),
          sort: z.string().optional().describe(SORT_DESCRIPTION),
          count: z.enum(['none', 'estimated', 'exact']).optional().describe(COUNT_DESCRIPTION),
          filter: z.string().optional().describe(FILTER_DESCRIPTION),
          fields: z.array(z.string()).optional().describe(FIELDS_DESCRIPTION),
          view: z.string().optional(),
          expand: z.array(z.string()).optional().describe(EXPAND_DESCRIPTION),
          expand_limit: z
            .record(z.string(), z.number().int().positive())
            .optional()
            .describe(EXPAND_LIMIT_DESCRIPTION),
          changes_since: z.string().optional(),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const stream = requireSafeName(args?.stream, 'stream');
        const query = pickQuery(args, SUPPORTED_QUERY_KEYS);
        const response = await rs.getJson(`/v1/streams/${encodeURIComponent(stream)}/records`, {
          query,
        });
        return toToolResult(response, providerUrl, `records from stream "${stream}"`);
      },
    },
    {
      name: 'search',
      title: 'Search PDPP records',
      description:
        'Search records via `GET /v1/search` (lexical), `/v1/search/semantic`, or `/v1/search/hybrid` per the `mode` argument. Returns the RS search envelope plus ChatGPT-compatible flattened `results`. Hits carry `connection_id` and `display_name`; pass `connection_id` to scope, omit to fan in. Per-mode pagination, filter, and capability support are advertised by `GET /v1/schema` and the protected-resource metadata `capabilities` block — hybrid mode does not currently support cursors. If the deployment does not advertise search, the RS error envelope is preserved in the tool result. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          q: z.string().min(1).describe('Search query string.'),
          streams: z.array(z.string()).optional(),
          limit: z.number().int().positive().max(200).optional(),
          cursor: z.string().optional(),
          mode: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
          filter: z.string().optional().describe(FILTER_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(SEARCH_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const path = searchPathForMode(args.mode);
        const query = {
          q: args.q,
          streams: args.streams,
          limit: args.limit,
          cursor: args.cursor,
          filter: args.filter,
          connection_id: args.connection_id,
          connector_instance_id: args.connector_instance_id,
        };
        const response = await rs.getJson(path, { query });
        return toSearchToolResult(response, providerUrl);
      },
    },
    {
      name: 'fetch',
      title: 'Fetch PDPP search result',
      description:
        'Fetch a single ChatGPT-compatible document by a result id returned from `search`. The default id format is `stream:record_id` and is read through `GET /v1/streams/{stream}/records/{record_id}`. When the identifier resolves to more than one connection under your grant and `connection_id` is omitted, the RS returns a typed `ambiguous_connection` (409) error listing `available_connections`; retry with the chosen `connection_id`. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          id: z.string().min(1).describe('Search result id, usually `stream:record_id`.'),
          expand: z.array(z.string()).optional().describe(EXPAND_DESCRIPTION),
          expand_limit: z
            .record(z.string(), z.number().int().positive())
            .optional()
            .describe(EXPAND_LIMIT_DESCRIPTION),
          fields: z.array(z.string()).optional().describe(FIELDS_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(FETCH_OUTPUT_SCHEMA_SHAPE),
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
        'Fetch a blob referenced by a prior authorized record via `GET /v1/blobs/{blob_id}` using the configured scoped token. Returns base64 bytes and the RS-reported mime type. When the blob identifier resolves to more than one connection under your grant and `connection_id` is omitted, the RS returns a typed `ambiguous_connection` (409) error listing `available_connections`; retry with the chosen `connection_id`. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          blob_id: z
            .string()
            .min(1)
            .describe('Blob identifier returned by a previous `query_records` or `search` call.'),
          range: z
            .string()
            .regex(/^bytes=\d+-\d*$/, { message: 'range must look like bytes=0-1023' })
            .optional(),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(BLOB_OUTPUT_SCHEMA_SHAPE),
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

function searchPathForMode(mode) {
  if (mode === 'semantic') return '/v1/search/semantic';
  if (mode === 'hybrid') return '/v1/search/hybrid';
  return '/v1/search';
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

// `content[]` is intentionally a concise human summary — the canonical
// `structuredContent` envelope is the contract for programmatic consumers.
// See:
//   openspec/changes/canonicalize-public-read-contract (5.3 prose content[] is
//   a concise summary only and not a second divergent JSON contract).
function toToolResult(response, providerUrl, label = 'response') {
  if (response.ok) {
    return {
      content: [
        {
          type: 'text',
          text: summarizeBody(response.body, label),
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
        text: summarizeSearch(response.body, results),
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
        text: summarizeFetchedDocument(document),
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

function summarizeBody(body, label) {
  if (Array.isArray(body)) {
    return `${label}: ${body.length} item(s). See structuredContent.data for the canonical envelope.`;
  }
  if (body && typeof body === 'object') {
    const dataLen = Array.isArray(body.data)
      ? body.data.length
      : Array.isArray(body.records)
        ? body.records.length
        : Array.isArray(body.streams)
          ? body.streams.length
          : null;
    const hasMore = body.has_more === true ? ' has_more=true.' : '';
    if (dataLen !== null) {
      return `${label}: ${dataLen} item(s).${hasMore} See structuredContent.data for the canonical envelope.`;
    }
    return `${label}: see structuredContent.data for the canonical envelope.`;
  }
  return `${label}: see structuredContent.data for the canonical envelope.`;
}

function summarizeSearch(body, results) {
  const hasMore = body && body.has_more === true ? ' has_more=true.' : '';
  return `search: ${results.length} hit(s).${hasMore} See structuredContent.data for the canonical envelope and structuredContent.results for the ChatGPT-compatible projection.`;
}

function summarizeFetchedDocument(document) {
  const title = document.title || document.id;
  return `fetched ${document.id}: ${title}. See structuredContent for the canonical record and ChatGPT-compatible document fields.`;
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
