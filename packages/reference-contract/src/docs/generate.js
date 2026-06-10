#!/usr/bin/env node
// Markdown reference-docs generator.
//
// Emits a concise route index and a query cookbook, driven from the same
// manifests that power the OpenAPI artifacts. Agents can grep this file for
// supported query shapes without reverse-engineering route code.
//
// Output:
//   - reference-implementation/docs/generated/reference-routes.md
//   - reference-implementation/docs/generated/query-cookbook.md

import { publicManifests } from '../public/index.ts';
import { referenceManifests } from '../reference/index.ts';

function methodBadge(method) {
  return `**${method}**`;
}

function manifestsToRouteMarkdown(manifests, title, lead) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  if (lead) { lines.push(lead); lines.push(''); }
  lines.push('| Method | Path | Operation | Summary |');
  lines.push('|--------|------|-----------|---------|');
  for (const m of manifests) {
    const safeSummary = (m.summary || '').replace(/\|/g, '\\|');
    lines.push(`| ${methodBadge(m.method)} | \`${m.path}\` | \`${m.id}\` | ${safeSummary} |`);
  }
  lines.push('');
  for (const m of manifests) {
    lines.push(`## ${m.id}`);
    lines.push('');
    lines.push(`\`${m.method} ${m.path}\``);
    lines.push('');
    if (m.summary) { lines.push(m.summary); lines.push(''); }
    const q = m.request?.query?.properties;
    if (q) {
      lines.push('### Query parameters');
      lines.push('');
      for (const [name, schema] of Object.entries(q)) {
        lines.push(`- \`${name}\` — ${describeSchema(schema)}`);
      }
      lines.push('');
    }
    const p = m.request?.params?.properties;
    if (p) {
      lines.push('### Path parameters');
      lines.push('');
      for (const [name, schema] of Object.entries(p)) {
        lines.push(`- \`${name}\` — ${describeSchema(schema)}`);
      }
      lines.push('');
    }
    const body = m.request?.body;
    if (body) {
      lines.push('### Request body');
      lines.push('');
      lines.push(`\`${body.contentType || 'application/json'}\``);
      if (body.schema?.properties) {
        for (const [name, schema] of Object.entries(body.schema.properties)) {
          const required = (body.schema.required || []).includes(name);
          lines.push(`- \`${name}\`${required ? ' (required)' : ''} — ${describeSchema(schema)}`);
        }
      }
      lines.push('');
    }
    lines.push('### Responses');
    lines.push('');
    for (const [code, spec] of Object.entries(m.responses || {})) {
      lines.push(`- \`${code}\` — ${spec.description || (spec.schema ? 'JSON body' : '')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function describeSchema(schema) {
  if (!schema) return '';
  if (schema.const) return `const \`${schema.const}\``;
  if (schema.enum) return `enum \`${schema.enum.join(' | ')}\``;
  const t = Array.isArray(schema.type) ? schema.type.join('|') : (schema.type || 'any');
  const bits = [t];
  if (schema.format) bits.push(`format: ${schema.format}`);
  if (typeof schema.minimum === 'number') bits.push(`min: ${schema.minimum}`);
  if (typeof schema.maximum === 'number') bits.push(`max: ${schema.maximum}`);
  if (schema.description) bits.push(schema.description);
  return bits.join(' · ');
}

function queryCookbook() {
  return [
    '# PDPP query cookbook',
    '',
    'All examples below target the public record-query surface at `/v1/streams/...`. Tokens are Bearer access tokens bound to a PDPP grant. Core spec §8 (Resource Server Interface) is authoritative for query syntax — the canonical `filter[<field>]` / `filter[<field>][op]` shapes, declaration-driven `query.range_filters` and `query.expand`, and the `limit_clamped` warning. This cookbook shows the smallest correct call for each shape; where it is terser than §8, §8 governs.',
    '',
    '## Discovery (one shot)',
    '',
    '`GET /v1/schema` returns every connector and stream visible to the bearer in a single response. Owner tokens (polyfill mode) get every owner-visible connector with no `connector_id` required; client tokens see only the streams in the grant. Use `GET /v1/schema?view=compact` for token-efficient agent discovery, and `GET /v1/schema?view=compact&stream=<name>` for the cheap per-stream schema step before querying records. Omitted `view` returns the full schema, including `schema`, `query` declarations, `field_capabilities`, `expand_capabilities`, and `freshness`.',
    '',
    '```http',
    'GET /v1/schema',
    'Authorization: Bearer <owner_or_client_token>',
    '```',
    '',
    'Use the per-field `field_capabilities[<field>]` flags (`exact_filter`, `range_filter`, `lexical_search`, `semantic_search`, `aggregation`) to learn which filters and aggregations are valid for each field without trial-and-error 400s. Per-stream `query.range_filters` / `query.aggregations` / `query.expand` lists are still emitted for callers that prefer the manifest view.',
    '',
    'For agents with limited context budget, prefer the compact schema view:',
    '',
    '```http',
    'GET /v1/schema?view=compact&stream=messages',
    'Authorization: Bearer <owner_or_client_token>',
    '```',
    '',
    'The compact view keeps stream identity, `granted_connections`, field names, declared types, and terse capability flags while omitting raw per-field JSON Schema blobs.',
    '',
    '## Exact filter',
    '',
    'Exact filters apply only to authorized top-level scalar fields. Unknown, unauthorized, or non-scalar fields are rejected.',
    '',
    '```http',
    'GET /v1/streams/top_artists/records?filter[name]=Aphex Twin',
    'Authorization: Bearer pdq_token_abc123',
    '```',
    '',
    '## Range filter (on a declared field)',
    '',
    'Range operators are valid only for fields declared under `query.range_filters` in the stream metadata. Supported operators: `gte`, `gt`, `lte`, `lt`. Coercion handles integer, number, date, and date-time fields.',
    '',
    '```http',
    'GET /v1/streams/top_artists/records?filter[source_updated_at][gte]=2026-01-01T00:00:00Z&order=asc',
    '```',
    '',
    '## Filtered retrieval',
    '',
    '`GET /v1/search` and `GET /v1/search/semantic` accept the same `filter[...]` syntax as record listing when the request names exactly one `streams` value. Range filters are still valid only for fields declared under that stream\'s `query.range_filters`; use stream metadata or `GET /v1/schema` to discover the supported fields and operators.',
    '',
    '```http',
    'GET /v1/search?q=invoice&streams[]=messages&filter[received_at][gte]=2026-04-01T00:00:00Z',
    'Authorization: Bearer pdq_token_abc123',
    '```',
    '',
    'Stream scoping uses repeated `streams[]=<name>` (or a single `streams=<name>`). There is no `filter[stream]` or `filter[connector_id]` parameter; cross-connector scoping happens automatically per the bearer\'s grant or owner scope.',
    '',
    'Retrieval responses may include typed implementation-relative scores when advertised. Portable score calibration, score-driven server-side reranking controls, and caller-controlled hybrid ranking remain deferred.',
    '',
    '## Aggregation',
    '',
    '`GET /v1/streams/<stream>/aggregate` computes one grant-safe aggregation over one stream. Supported metrics are `count`, numeric `sum`, and numeric/date `min`/`max`. Grouped counts use `metric=count&group_by=<field>&limit=N` and return buckets ordered by count descending, then key ascending. Aggregate fields and grouping fields must be explicitly declared under `query.aggregations` and authorized by the caller grant.',
    '',
    '```http',
    'GET /v1/streams/transactions/aggregate?metric=sum&field=amount&filter[date][gte]=2026-01-01',
    'Authorization: Bearer pdq_token_abc123',
    '```',
    '',
    '```http',
    'GET /v1/streams/messages/aggregate?metric=count&group_by=has_attachments&limit=2',
    'Authorization: Bearer pdq_token_abc123',
    '```',
    '',
    '## Sparse fieldset',
    '',
    'Field selection is limited to top-level field names. Schema-required fields are always included. Mutually exclusive with `view`.',
    '',
    '```http',
    'GET /v1/streams/top_artists/records?fields=id,name,genres',
    '```',
    '',
    '## Named view',
    '',
    '```http',
    'GET /v1/streams/top_artists/records?view=basic',
    '```',
    '',
    '## Logical cursor pagination',
    '',
    'Records are sorted by `(cursor_field, primary_key)`. Null cursor values sort after present values. Cursors are opaque — clients must not parse or construct them. Cursors are direction-bound: follow a page cursor with the same `order` value that produced it. To change direction, restart pagination without a cursor; the reference rejects order-mismatched cursors as `invalid_cursor`.',
    '',
    '`limit` defaults to 25 and is capped at 100. A request for more than 100 is clamped to 100 and returns a non-fatal `meta.warnings[]` entry with `code: "limit_clamped"`, not an error — page forward with the returned cursor rather than expecting a larger page.',
    '',
    '```http',
    'GET /v1/streams/top_artists/records?order=asc&limit=50',
    '... then ...',
    'GET /v1/streams/top_artists/records?order=asc&limit=50&cursor=<next_cursor>',
    '```',
    '',
    '## Incremental sync (changes_since)',
    '',
    '`changes_since` returns records whose authorized projection changed since the previous sync. Use `changes_since=beginning` for the initial sync, then use `next_changes_since` from the terminal page to seed the next session. Do not pass list-page `next_cursor` values as `changes_since`.',
    '',
    '```http',
    'GET /v1/streams/top_artists/records?changes_since=beginning',
    '... later ...',
    'GET /v1/streams/top_artists/records?changes_since=<next_changes_since>',
    '```',
    '',
    '## Expansion',
    '',
    'Expand a relationship declared under `query.expand`. Depth is 1. Use `expand_limit[<relation>]` to bound expanded `has_many` children. Expansion is incompatible with `changes_since`; incremental sync pages return changed parent records only.',
    '',
    '```http',
    'GET /v1/streams/saved_tracks/records?expand[]=recently_played&expand_limit[recently_played]=5',
    '```',
    '',
    '## Blob fetch',
    '',
    'Records that include attachment-like bytes carry a `data.blob_ref` object. The reference RS decorates that object with a `fetch_url` (e.g., `/v1/blobs/<blob_id>`) which is the only supported byte-fetch path. There is no `/v1/attachments/<id>/content` (or similar) endpoint — discover bytes from the record\'s `blob_ref.fetch_url` rather than constructing attachment-specific content URLs.',
    '',
    '```http',
    'GET /v1/blobs/<blob_id>',
    'Authorization: Bearer pdq_token_abc123',
    '```',
    '',
    'Authorized only if the caller holds a grant that includes a record referencing this `blob_id` via a visible `blob_ref` field.',
    '',
    '## Provider-connect flow (reference)',
    '',
    '1. Register a client: `POST /oauth/register` (DCR initial access token required).',
    '2. Start a grant request: `POST /oauth/par` with `authorization_details[0].type = https://pdpp.org/data-access`.',
    '3. Approve via the hosted consent page or `POST /consent/approve` with `request_uri` + subject id.',
    '4. In the current thin reference flow, `POST /consent/approve` returns `{ grant_id, token, grant }` directly; there is no follow-on `/oauth/token` exchange for third-party client connect yet.',
    '',
    '## Owner device flow',
    '',
    '1. `POST /oauth/device_authorization` → returns `device_code` + `user_code`.',
    '2. `POST /device/approve` with `user_code` + `subject_id`.',
    '3. `POST /oauth/token` with `grant_type = urn:ietf:params:oauth:grant-type:device_code` → returns the owner bearer token.',
    '',
    '## Error codes (spec §8)',
    '',
    '- `400 invalid_request` — malformed query shape (unknown param, bad filter shape, nested path).',
    '- `400 unknown_field` — `fields=` references a field outside the stream schema.',
    '- `400 invalid_expand` — expansion requests an undeclared or non-`has_many` relation.',
    '- `400 invalid_cursor` — cursor token malformed.',
    '- `403 field_not_granted` — filter targets a field outside the grant projection.',
    '- `403 grant_stream_not_allowed` — stream not in grant.',
    '- `403 insufficient_scope` — expansion requests a stream not in the grant.',
    '- `404 not_found` — stream or record not found.',
    '- `404 blob_not_found` — `blob_id` is unknown or stale.',
    '- `410 cursor_expired` — `changes_since` cursor too old; full re-sync required.',
    '',
  ].join('\n');
}

function withSingleTrailingNewline(markdown) {
  return `${markdown.trimEnd()}\n`;
}

export function generateDocs() {
  return {
    routes: manifestsToRouteMarkdown(
      publicManifests,
      'PDPP reference-implementation public API',
      'Generated from `packages/reference-contract/src/public/`. Do not edit by hand.',
    ),
    referenceRoutes: manifestsToRouteMarkdown(
      referenceManifests,
      'PDPP reference-implementation /_ref operator surface',
      'Generated from `packages/reference-contract/src/reference/`. Reference-designated routes: not part of the public PDPP contract.',
    ),
    cookbook: queryCookbook(),
  };
}

async function main() {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname, join, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(here, '../../../../reference-implementation/docs/generated');
  await mkdir(outDir, { recursive: true });
  const { routes, referenceRoutes, cookbook } = generateDocs();
  await writeFile(join(outDir, 'reference-routes.md'), withSingleTrailingNewline(routes));
  await writeFile(join(outDir, 'reference-ref-routes.md'), withSingleTrailingNewline(referenceRoutes));
  await writeFile(join(outDir, 'query-cookbook.md'), withSingleTrailingNewline(cookbook));
  process.stdout.write(`wrote ${outDir}/reference-routes.md\n`);
  process.stdout.write(`wrote ${outDir}/reference-ref-routes.md\n`);
  process.stdout.write(`wrote ${outDir}/query-cookbook.md\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
