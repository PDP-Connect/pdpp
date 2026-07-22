// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PackageRsClient — package-aware RS client for the hosted MCP adapter.
 *
 * Conforms to the same surface as `@pdpp/mcp-server` RsClient
 * (`getJson`, `getRaw`, `postJson`, `patchJson`, `deleteJson`, `buildUrl`)
 * but does not hold a single bearer. Instead it holds the package's active
 * child-grant members and routes each call to one or more children:
 *
 *   - `GET /v1/schema`              — fan out, merge streams + granted_connections.
 *   - `GET /.well-known/oauth-protected-resource` — server-global passthrough.
 *   - `GET /v1/streams`             — fan out, tag each row with source identity.
 *   - `GET /v1/streams/:s/records`  — require source selector → single child.
 *   - `GET /v1/streams/:s/records/:id` — same as above.
 *   - `GET /v1/streams/:s`          — same as above.
 *   - `GET /v1/search[/...]`        — fan out, tailor streams[] per child
 *                                     grant, merge results.
 *   - `GET /v1/blobs/:id` (getRaw)  — require source selector → single child.
 *
 *   - `POST   /v1/event-subscriptions`           — require source selector.
 *   - `GET    /v1/event-subscriptions`           — fan out, merge data[].
 *   - `GET    /v1/event-subscriptions/:id`       — locate owning child.
 *   - `PATCH  /v1/event-subscriptions/:id`       — locate owning child.
 *   - `DELETE /v1/event-subscriptions/:id`       — locate owning child.
 *   - `POST   /v1/event-subscriptions/:id/test-event` — locate owning child.
 *
 * Each child read passes through the same RS endpoint the MCP adapter
 * selected; this preserves the spec's "MCP is an adapter over the same
 * REST contract" guarantee. Every record/blob/event-subscription read is
 * executed under exactly one child grant's bearer.
 *
 * Spec: openspec/changes/add-hosted-mcp-grant-packages/
 */

import { RsClient } from '../../packages/mcp-server/src/rs-client.js';
import { schemaSourceOptions } from '../operations/rs-schema-get/compact-view.ts';

const PACKAGE_INTROSPECTION_PATH = null;
const AMBIGUOUS_CONNECTION_LIST_LIMIT = 12;

/**
 * Build one single-bearer RsClient. Thin factory so the hosted-MCP route
 * adapter can construct a single-grant (`client`-token) RsClient against a
 * chosen fetch base (e.g. the internal RS base for self-calls) without
 * importing `@pdpp/mcp-server` internals directly. Mirrors how
 * `createPackageRsClient` builds each child client.
 *
 * @param {object} args
 * @param {string} args.providerUrl   — fetch base for HTTP self-calls.
 * @param {string} args.accessToken   — the single grant bearer.
 * @param {Function} [args.fetch]
 * @param {string}  [args.userAgent]
 */
export function createRsClient({ providerUrl, accessToken, fetch = globalThis.fetch, userAgent }) {
  if (!providerUrl) throw new TypeError('createRsClient requires providerUrl');
  return new RsClient({ providerUrl, accessToken, fetch, userAgent });
}

/**
 * Build one PackageRsClient.
 *
 * @param {object} args
 * @param {string} args.providerUrl
 * @param {Array}  args.members        — active grant-package members.
 * @param {Function} [args.fetch]      — fetch implementation.
 * @param {string}  [args.userAgent]
 */
export function createPackageRsClient({ providerUrl, members, fetch = globalThis.fetch, userAgent }) {
  if (!providerUrl) throw new TypeError('PackageRsClient requires providerUrl');
  if (!Array.isArray(members) || members.length === 0) {
    throw new TypeError('PackageRsClient requires at least one active member');
  }

  // Build a child RsClient per member.
  const children = members.map((member) => ({
    member,
    client: new RsClient({ providerUrl, accessToken: member.token, fetch, userAgent }),
  }));

  return new PackageRsClient({ providerUrl, children, fetch, userAgent });
}

class PackageRsClient {
  constructor({ providerUrl, children, fetch, userAgent }) {
    this.providerUrl = providerUrl.replace(/\/$/, '');
    this.children = children;
    this.fetch = fetch;
    this.userAgent = userAgent ?? '@pdpp/mcp-server';
  }

  // -------- public RsClient-compatible surface --------

  async getJson(path, { query, headers } = {}) {
    const route = routeFor('GET', path);
    if (route.kind === 'passthrough') return this.passthroughGet(path, { query, headers });
    if (route.kind === 'fanout_schema') return this.fanoutSchema({ query, headers });
    if (route.kind === 'fanout_streams') return this.fanoutStreams({ query, headers });
    if (route.kind === 'fanout_search') return this.fanoutSearch(path, { query, headers });
    if (route.kind === 'fanout_event_sub_list') return this.fanoutEventSubList({ query, headers });
    if (route.kind === 'locate_event_sub') return this.locateEventSubAndGet(route.id, { query, headers });
    if (route.kind === 'source_required_get') {
      return this.sourceRequiredJson('GET', path, { query, headers });
    }
    // Fallback: not all paths are mapped (e.g., streams resource template).
    return this.sourceRequiredJson('GET', path, { query, headers });
  }

  // Server-global public discovery is not scoped to any package child.
  // Reusing one child client preserves the RsClient-compatible response shape.
  async passthroughGet(path, { query, headers } = {}) {
    return this.children[0].client.getJson(path, { query, headers });
  }

  async getRaw(path, { query, headers } = {}) {
    // Blob / binary reads always require a source selector.
    return this.sourceRequiredRaw('GET', path, { query, headers });
  }

  async postJson(path, { body, query, headers } = {}) {
    const route = routeFor('POST', path);
    if (route.kind === 'event_sub_create') return this.createEventSubForChild({ body, query, headers });
    if (route.kind === 'event_sub_test_event') {
      return this.locateEventSubAndForward(route.id, 'POST', `${path}`, { body, query, headers });
    }
    return this.sourceRequiredJson('POST', path, { body, query, headers });
  }

  async patchJson(path, { body, query, headers } = {}) {
    const route = routeFor('PATCH', path);
    if (route.kind === 'locate_event_sub') {
      return this.locateEventSubAndForward(route.id, 'PATCH', path, { body, query, headers });
    }
    return this.sourceRequiredJson('PATCH', path, { body, query, headers });
  }

  async deleteJson(path, { query, headers } = {}) {
    const route = routeFor('DELETE', path);
    if (route.kind === 'locate_event_sub') {
      return this.locateEventSubAndForward(route.id, 'DELETE', path, { query, headers });
    }
    return this.sourceRequiredJson('DELETE', path, { query, headers });
  }

  buildUrl(path, query) {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, `${this.providerUrl}/`);
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) for (const e of value) url.searchParams.append(key, String(e));
        else if (typeof value === 'object') {
          throw new TypeError(
            `query parameter '${key}' must be a scalar or array; encode nested query shapes explicitly before calling PackageRsClient`,
          );
        }
        else url.searchParams.append(key, String(value));
      }
    }
    return url.toString();
  }

  // -------- fanout strategies --------

  async fanoutSchema({ query, headers }) {
    if (query?.connection_id) {
      const scoped = pickChildByConnectionId(this.children, query.connection_id);
      if (!scoped) {
        return typedError('not_found', `connection_id "${query.connection_id}" is not part of this package`, this.children);
      }
      const result = await scoped.client.getJson('/v1/schema', { query: stripConnectionId(query), headers });
      return mergeSchemaEnvelopes([scoped], [result]);
    }

    if (query?.detail === 'full') {
      if (!query?.stream) {
        return typedError(
          'invalid_request',
          'schema detail "full" requires `stream`; call /v1/schema?view=compact for global discovery, then /v1/schema?stream=<name>&connection_id=<cin>&detail=full for exhaustive detail.',
          this.children,
          { status: 400, param: 'detail', includeAvailableConnections: false },
        );
      }

      const preflightQuery = { ...query, view: 'compact' };
      delete preflightQuery.detail;
      const preflight = await Promise.all(
        this.children.map(({ client }) => client.getJson('/v1/schema', { query: preflightQuery, headers })),
      );
      const matches = [];
      const available = [];
      preflight.forEach((result, index) => {
        if (!result.ok) return;
        const options = schemaSourceOptions(schemaDocument(result.body), { stream: query.stream });
        if (options.length === 0) return;
        matches.push({ child: this.children[index], options });
        available.push(...options);
      });
      if (available.length > 1) {
        return typedError(
          'ambiguous_schema_detail',
          `schema detail "full" for stream "${query.stream}" matches ${available.length} sources; retry with connection_id to fetch one source's exhaustive schema.`,
          this.children,
          {
            param: 'connection_id',
            availableConnections: available,
            retryWith: 'connection_id',
          },
        );
      }
      if (matches.length === 1) {
        const result = await matches[0].child.client.getJson('/v1/schema', { query, headers });
        return mergeSchemaEnvelopes([matches[0].child], [result]);
      }
    }

    const results = await Promise.all(
      this.children.map(({ client }) => client.getJson('/v1/schema', { query, headers })),
    );
    return mergeSchemaEnvelopes(this.children, results);
  }

  async fanoutStreams({ query, headers }) {
    // If caller scoped to one connection_id, route to that child only.
    if (query?.connection_id) {
      const scoped = pickChildByConnectionId(this.children, query.connection_id);
      if (!scoped) {
        return typedError('not_found', `connection_id "${query.connection_id}" is not part of this package`, this.children);
      }
      return scoped.client.getJson('/v1/streams', { query, headers });
    }

    const results = await Promise.all(
      this.children.map(({ client }) => client.getJson('/v1/streams', { query, headers })),
    );
    return mergeListEnvelopes(this.children, results, '/v1/streams');
  }

  async fanoutSearch(path, { query, headers }) {
    if (query?.connection_id) {
      const scoped = pickChildByConnectionId(this.children, query.connection_id);
      if (!scoped) {
        return typedError('not_found', `connection_id "${query.connection_id}" is not part of this package`, this.children);
      }
      return scoped.client.getJson(path, { query, headers });
    }

    const results = await Promise.all(
      this.children.map(({ member, client }) => {
        const childQuery = searchQueryForChild(query, member);
        if (childQuery === null) return emptySearchResponse();
        return client.getJson(path, { query: childQuery, headers });
      }),
    );
    return mergeSearchEnvelopes(this.children, results, path, query);
  }

  async sourceRequiredJson(method, path, opts) {
    const child = await this.resolveChildOrError(opts);
    if (child.error) return child.error;
    return child.client[method === 'GET' ? 'getJson' : method === 'POST' ? 'postJson' : method === 'PATCH' ? 'patchJson' : 'deleteJson'](
      path,
      opts,
    );
  }

  async sourceRequiredRaw(_method, path, opts) {
    const child = await this.resolveChildOrError(opts);
    if (child.error) return child.error;
    return child.client.getRaw(path, opts);
  }

  async resolveChildOrError({ query }) {
    const connectionId = query?.connection_id;
    if (connectionId) {
      const child = pickChildByConnectionId(this.children, connectionId);
      if (child) return child;
      return { error: typedError('not_found', `connection_id "${connectionId}" is not part of this package`, this.children) };
    }
    if (this.children.length === 1) return this.children[0];
    return {
      error: await this.ambiguousConnectionError(
        'This hosted MCP package contains multiple sources. Pass `connection_id` to select one. Use `schema` to discover available connections.',
      ),
    };
  }

  async ambiguousConnectionError(message) {
    return typedError('ambiguous_connection', message, this.children);
  }

  // -------- event subscriptions --------

  async createEventSubForChild({ body, query, headers }) {
    // Selector can come from query (?connection_id) OR top-level body.connection_id.
    const sel = query?.connection_id ?? body?.connection_id;
    let child;
    if (sel) {
      child = pickChildByConnectionId(this.children, sel);
      if (!child) return typedError('not_found', `connection_id "${sel}" is not part of this package`, this.children);
    } else if (this.children.length === 1) {
      child = this.children[0];
    } else {
      return await this.ambiguousConnectionError('This hosted MCP package contains multiple sources. Pass `connection_id` when creating an event subscription so it binds to exactly one child grant.');
    }
    const childBody = body ? { ...body } : {};
    delete childBody.connection_id;
    return child.client.postJson('/v1/event-subscriptions', { body: childBody, query: stripConnectionId(query), headers });
  }

  async fanoutEventSubList({ query, headers }) {
    const results = await Promise.all(
      this.children.map(({ client }) => client.getJson('/v1/event-subscriptions', { query, headers })),
    );
    return mergeEventSubListEnvelopes(this.children, results);
  }

  async locateEventSubAndGet(id, opts) {
    const found = await this.locateEventSubOwner(id);
    if (found.error) return found.error;
    return found.child.client.getJson(`/v1/event-subscriptions/${encodeURIComponent(id)}`, opts);
  }

  async locateEventSubAndForward(id, method, path, opts) {
    const found = await this.locateEventSubOwner(id);
    if (found.error) return found.error;
    const m = method === 'GET' ? 'getJson' : method === 'POST' ? 'postJson' : method === 'PATCH' ? 'patchJson' : 'deleteJson';
    return found.child.client[m](path, opts);
  }

  async locateEventSubOwner(id) {
    const probes = await Promise.all(
      this.children.map(async ({ member, client }) => {
        try {
          const r = await client.getJson(`/v1/event-subscriptions/${encodeURIComponent(id)}`);
          return { member, client, ok: r.ok && r.status === 200 };
        } catch {
          return { member, client, ok: false };
        }
      }),
    );
    const owner = probes.find((p) => p.ok);
    if (owner) return { child: { member: owner.member, client: owner.client } };
    return {
      error: {
        ok: false,
        status: 404,
        error: {
          type: 'not_found',
          code: 'not_found',
          message: `event subscription "${id}" is not owned by any active member of this hosted MCP package`,
        },
        requestId: null,
        contentType: 'application/json',
      },
    };
  }
}

// -------- routing classifier --------

function routeFor(method, path) {
  const clean = path.split('?')[0];

  if (method === 'GET' && clean === '/.well-known/oauth-protected-resource') {
    return { kind: 'passthrough' };
  }

  if (method === 'GET' && clean === '/v1/schema') return { kind: 'fanout_schema' };
  if (method === 'GET' && clean === '/v1/streams') return { kind: 'fanout_streams' };
  if (method === 'GET' && (clean === '/v1/search' || clean === '/v1/search/semantic' || clean === '/v1/search/hybrid')) {
    return { kind: 'fanout_search' };
  }
  if (method === 'GET' && clean === '/v1/event-subscriptions') return { kind: 'fanout_event_sub_list' };

  if (method === 'POST' && clean === '/v1/event-subscriptions') return { kind: 'event_sub_create' };

  const eventSubMatch = clean.match(/^\/v1\/event-subscriptions\/([^/]+)$/);
  if (eventSubMatch) return { kind: 'locate_event_sub', id: decodeURIComponent(eventSubMatch[1]) };
  const testEventMatch = clean.match(/^\/v1\/event-subscriptions\/([^/]+)\/test-event$/);
  if (testEventMatch && method === 'POST') {
    return { kind: 'event_sub_test_event', id: decodeURIComponent(testEventMatch[1]) };
  }

  return { kind: 'source_required_get' };
}

// -------- selectors --------

function pickChildByConnectionId(children, connectionId) {
  if (!connectionId) return null;
  return children.find(({ member }) => member.connection_id === connectionId) || null;
}

function stripConnectionId(query) {
  if (!query || typeof query !== 'object') return query;
  const { connection_id: _omit, ...rest } = query;
  return rest;
}

function searchQueryForChild(query, member) {
  const requested = requestedStreamsFromQuery(query);
  if (requested.length === 0) return query;
  const granted = grantedStreamNames(member);
  if (!granted) return query;

  const selected = granted.has('*') ? requested : requested.filter((stream) => granted.has(stream));
  if (selected.length === 0) return null;

  const next = query && typeof query === 'object' ? { ...query } : {};
  delete next.streams;
  delete next['streams[]'];
  next.streams = selected;
  return next;
}

function requestedStreamsFromQuery(query) {
  if (!query || typeof query !== 'object') return [];
  const values = [];
  collectStreamQueryValues(values, query.streams);
  collectStreamQueryValues(values, query['streams[]']);

  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function collectStreamQueryValues(out, value) {
  if (Array.isArray(value)) {
    for (const entry of value) collectStreamQueryValues(out, entry);
    return;
  }
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length > 0) out.push(trimmed);
}

function grantedStreamNames(member) {
  const streams = member?.grant?.streams;
  if (!Array.isArray(streams)) return null;
  const names = streams
    .map((stream) => (typeof stream?.name === 'string' ? stream.name.trim() : ''))
    .filter((name) => name.length > 0);
  return new Set(names);
}

function emptySearchResponse() {
  return {
    ok: true,
    status: 200,
    body: { object: 'list', data: [], has_more: false },
    requestId: null,
    contentType: 'application/json',
  };
}

// -------- envelope helpers --------

function memberSourceTag(member) {
  const connectorKey = member.source?.id ?? null;
  return {
    grant_id: member.grant_id,
    connector_id: connectorKey,
    connector_key: connectorKey,
    connection_id: member.connection_id ?? null,
    ...(member.source?.display_name ? { display_name: member.source.display_name } : {}),
  };
}

function availableConnectionsList(children, { limit = Infinity } = {}) {
  return children.slice(0, limit).map(({ member }) => ({
    grant_id: member.grant_id,
    connector_key: member.source?.id ?? null,
    connection_id: member.connection_id ?? null,
    ...(member.source?.display_name ? { display_name: member.source.display_name } : {}),
  }));
}

function unavailableConnectionsList(entries) {
  return entries.map(({ child, error }) => ({
    ...availableConnectionsList([child])[0],
    status: error?.status ?? null,
    error: {
      code: error?.code ?? 'source_unavailable',
      message: error?.message ?? 'Source is unavailable',
    },
  }));
}

function typedError(code, message, children, options = {}) {
  const unavailableConnections = unavailableConnectionsList(options.unavailableChildren ?? []);
  const limit = options.availableConnectionLimit ?? AMBIGUOUS_CONNECTION_LIST_LIMIT;
  const availableConnections = Array.isArray(options.availableConnections)
    ? options.availableConnections
    : options.includeAvailableConnections === false
      ? []
      : availableConnectionsList(children, { limit });
  const error = {
    type: code,
    code,
    message,
    ...(options.param ? { param: options.param } : {}),
    ...(availableConnections.length > 0 ? { available_connections: availableConnections } : {}),
    ...(options.includeAvailableConnections === false ? {} : { available_connection_count: children.length }),
    ...(options.retryWith === null ? {} : { retry_with: options.retryWith ?? 'connection_id' }),
  };
  if (options.includeAvailableConnections !== false && !Array.isArray(options.availableConnections) && availableConnections.length < children.length) {
    error.available_connections_truncated = true;
    error.available_connections_omitted = children.length - availableConnections.length;
    error.discovery_hint = 'Call `schema` for the full granted connection index before retrying with `connection_id`.';
  }
  if (unavailableConnections.length > 0) {
    error.unavailable_connections = unavailableConnections;
  }
  return {
    ok: false,
    status: options.status ?? (code === 'not_found' ? 404 : 409),
    error,
    requestId: null,
    contentType: 'application/json',
  };
}

function schemaDocument(body) {
  if (body?.data && typeof body.data === 'object' && !Array.isArray(body.data)) return body.data;
  return body;
}

function normalizeSchemaChildEnvelope(child, result) {
  const childData = result.body?.data && typeof result.body.data === 'object'
    ? result.body.data
    : (result.body && typeof result.body === 'object' ? result.body : {});
  const sourceTag = memberSourceTag(child.member);
  const connectorItems = [];
  const entries = [];
  const connectors = Array.isArray(childData.connectors) ? childData.connectors : [];

  if (connectors.length > 0) {
    for (const connector of connectors) {
      const connectorSource = connector?.source && typeof connector.source === 'object'
        ? { ...sourceTag, ...connector.source }
        : sourceTag;
      connectorItems.push({ ...connector, source: connectorSource });
      for (const stream of Array.isArray(connector?.streams) ? connector.streams : []) {
        entries.push({
          stream,
          connections: Array.isArray(stream?.granted_connections) ? stream.granted_connections : [],
        });
      }
    }
  } else {
    for (const stream of Array.isArray(childData.streams) ? childData.streams : []) {
      entries.push({ stream, connections: [] });
    }
    for (const connection of Array.isArray(childData.granted_connections) ? childData.granted_connections : []) {
      entries.push({ connections: [connection] });
    }
  }

  return { connectorItems, entries, sourceTag, member: child.member };
}

function aggregateSchemaChildEnvelope(aggregate, envelope) {
  for (const connectorItem of envelope.connectorItems) aggregate.connectorItems.push(connectorItem);
  for (const entry of envelope.entries) {
    if ('stream' in entry) {
      const key = `${entry.stream?.name ?? ''}::${envelope.member.grant_id}::${envelope.member.connection_id ?? ''}`;
      if (aggregate.seenStream.has(key)) continue;
      aggregate.seenStream.add(key);
      aggregate.streams.push({ ...entry.stream, source: envelope.sourceTag });
    }
    for (const connection of entry.connections) {
      const key = `${connection?.connection_id ?? ''}::${envelope.member.grant_id}`;
      if (aggregate.seenConnection.has(key)) continue;
      aggregate.seenConnection.add(key);
      aggregate.connections.push({ ...connection, source: envelope.sourceTag });
    }
  }
}

function mergeSchemaEnvelopes(children, results) {
  // The canonical /v1/schema response shape is
  //   { data: { object: 'schema', connectors: [{ object:'connector',
  //       source, streams:[{ name, granted_connections?, ...}], stream_count }],
  //       connector_count, stream_count, source } }
  // Each per-child fan-out call returns one connector item (the child's
  // bound source). We merge by:
  //   - flattening streams from every child's connectors[] into a single
  //     `data.streams` array tagged with the child's source identity,
  //     so MCP consumers get one stream list to iterate without having
  //     to walk a `connectors[]` shape that only exists in the per-child
  //     envelope;
  //   - flattening per-stream `granted_connections` into a single
  //     `data.granted_connections` for the same reason;
  //   - attaching `data.package = { grant_package, member_count, sources }`
  //     so consumers can tell they are looking at a package fanout.
  // The original `connectors[]` array is preserved verbatim under
  // `data.connectors` (concatenated across children) so callers that
  // already speak the canonical schema envelope keep working.
  const ok = results.find((r) => r.ok);
  if (!ok) return results[0];

  const baseBody = ok.body && typeof ok.body === 'object' ? { ...ok.body } : { data: {} };
  const data = baseBody.data && typeof baseBody.data === 'object' ? { ...baseBody.data } : {};

  const aggregate = {
    streams: [],
    connections: [],
    connectorItems: [],
    seenStream: new Set(),
    seenConnection: new Set(),
  };

  results.forEach((r, i) => {
    if (!r.ok) return;
    aggregateSchemaChildEnvelope(aggregate, normalizeSchemaChildEnvelope(children[i], r));
  });

  data.streams = aggregate.streams;
  data.granted_connections = aggregate.connections;
  if (aggregate.connectorItems.length > 0) {
    data.connectors = aggregate.connectorItems;
    data.connector_count = aggregate.connectorItems.length;
    data.stream_count = aggregate.streams.length;
  }
  data.package = {
    grant_package: true,
    member_count: children.length,
    sources: children.map(({ member }) => memberSourceTag(member)),
  };
  baseBody.data = data;
  baseBody.meta = {
    ...(baseBody.meta || {}),
    package: {
      member_count: children.length,
      partial: results.some((r) => !r.ok),
    },
  };
  return { ...ok, body: baseBody };
}

function mergeListEnvelopes(children, results, _path) {
  // For /v1/streams: shape is { data: [...] }. Concatenate; tag each row.
  const ok = results.find((r) => r.ok);
  if (!ok) return results[0];

  const merged = [];
  const meta = { package: { member_count: children.length, partial: false } };
  const warnings = [];

  results.forEach((r, i) => {
    const child = children[i];
    if (!r.ok) {
      meta.package.partial = true;
      warnings.push({
        code: 'source_unavailable',
        message: `Source ${child.member.connection_id || child.member.source?.id || child.member.grant_id} returned ${r.status}`,
        source: memberSourceTag(child.member),
      });
      return;
    }
    const rows = Array.isArray(r.body?.data) ? r.body.data : (Array.isArray(r.body) ? r.body : []);
    for (const row of rows) {
      merged.push({ ...row, source: memberSourceTag(child.member) });
    }
  });

  const baseBody = ok.body && typeof ok.body === 'object' ? { ...ok.body } : {};
  baseBody.data = merged;
  baseBody.meta = { ...(baseBody.meta || {}), ...meta };
  if (warnings.length > 0) {
    const existing = Array.isArray(baseBody.meta?.warnings) ? baseBody.meta.warnings : [];
    baseBody.meta.warnings = [...existing, ...warnings];
  }
  return { ...ok, body: baseBody };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: packet requires this verbatim five-way envelope writer.
function placeSearchHitsInEnvelope(baseBody, limitedHits, totalScanned) {
  if (Array.isArray(baseBody.data)) {
    baseBody.data = limitedHits;
  } else if (baseBody.data && typeof baseBody.data === 'object' && Array.isArray(baseBody.data.data)) {
    baseBody.data = { ...baseBody.data, data: limitedHits };
  } else if (baseBody.data && typeof baseBody.data === 'object' && Array.isArray(baseBody.data.results)) {
    baseBody.data = { ...baseBody.data, results: limitedHits };
    if (totalScanned > 0) baseBody.data.scanned = totalScanned;
  } else if (Array.isArray(baseBody.results)) {
    baseBody.results = limitedHits;
  } else {
    baseBody.data = { results: limitedHits };
  }
}

function mergeSearchEnvelopes(children, results, _path, query = {}) {
  const ok = results.find((r) => r.ok);
  if (!ok) return results[0];

  const requestedLimit = parsePositiveInt(query?.limit) ?? 25;
  const mergedHits = [];
  const warnings = [];
  let totalScanned = 0;
  let childHasMore = false;

  results.forEach((r, i) => {
    const child = children[i];
    if (!r.ok) {
      warnings.push({
        code: 'source_unavailable',
        message: `Source ${child.member.connection_id || child.member.source?.id || child.member.grant_id} returned ${r.status}`,
        source: memberSourceTag(child.member),
      });
      return;
    }
    const hits = extractSearchHits(r.body);
    for (const hit of hits) {
      mergedHits.push(decorateSearchHitWithSource(hit, memberSourceTag(child.member)));
    }
    if (typeof r.body?.data?.scanned === 'number') totalScanned += r.body.data.scanned;
    if (searchBodyHasMore(r.body)) childHasMore = true;
  });

  const dedupedHits = dedupeSearchHits(mergedHits);
  const limitedHits = dedupedHits.slice(0, requestedLimit);
  const truncated = dedupedHits.length > limitedHits.length;
  const sourceMix = sourceMixForHits(limitedHits);
  const baseBody = ok.body && typeof ok.body === 'object' ? { ...ok.body } : {};
  placeSearchHitsInEnvelope(baseBody, limitedHits, totalScanned);
  baseBody.has_more = truncated || childHasMore || baseBody.has_more === true;
  baseBody.meta = {
    ...(baseBody.meta || {}),
    package: {
      member_count: children.length,
      partial: warnings.length > 0,
      fanout_limit: requestedLimit,
      merged_hit_count: dedupedHits.length,
      returned_hit_count: limitedHits.length,
      source_mix: sourceMix,
    },
  };
  if (warnings.length > 0) {
    const existing = Array.isArray(baseBody.meta.warnings) ? baseBody.meta.warnings : [];
    baseBody.meta.warnings = [...existing, ...warnings];
  }
  return { ...ok, body: baseBody };
}

function extractSearchHits(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.results)) return body.results;
  if (Array.isArray(body.data)) return body.data;
  if (body.data && typeof body.data === 'object' && Array.isArray(body.data.data)) return body.data.data;
  if (body.data && typeof body.data === 'object' && Array.isArray(body.data.results)) return body.data.results;
  return [];
}

function parsePositiveInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function decorateSearchHitWithSource(hit, fallbackSource) {
  const source = hit && typeof hit === 'object' && hit.source && typeof hit.source === 'object'
    ? { ...fallbackSource, ...hit.source }
    : fallbackSource;
  return {
    ...(hit && typeof hit === 'object' ? hit : { value: hit }),
    source,
    connection_id: firstNonEmptyString(hit?.connection_id, hit?.connector_instance_id, source.connection_id),
    connector_key: firstNonEmptyString(hit?.connector_key, hit?.connector_id, source.connector_key, source.connector_id),
    ...(firstNonEmptyString(hit?.display_name, source.display_name)
      ? { display_name: firstNonEmptyString(hit?.display_name, source.display_name) }
      : {}),
  };
}

function dedupeSearchHits(hits) {
  const seen = new Set();
  const out = [];
  for (const hit of hits) {
    const key = searchHitDedupeKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function searchHitDedupeKey(hit) {
  const source = hit && typeof hit === 'object' && hit.source && typeof hit.source === 'object' ? hit.source : {};
  return [
    firstNonEmptyString(hit?.connection_id, source.connection_id),
    firstNonEmptyString(hit?.connector_key, hit?.connector_id, source.connector_key, source.connector_id),
    firstNonEmptyString(hit?.stream, hit?.stream_name, hit?.streamName),
    firstNonEmptyString(hit?.record_key, hit?.recordKey, hit?.record_id, hit?.recordId, hit?.id, hit?.url),
  ].map((part) => part ?? '').join('\0');
}

function sourceMixForHits(hits) {
  const byConnection = new Map();
  for (const hit of hits) {
    const source = hit && typeof hit === 'object' && hit.source && typeof hit.source === 'object' ? hit.source : {};
    const connectionId = firstNonEmptyString(hit?.connection_id, source.connection_id) ?? null;
    const connectorKey = firstNonEmptyString(hit?.connector_key, hit?.connector_id, source.connector_key, source.connector_id) ?? null;
    const displayName = firstNonEmptyString(hit?.display_name, source.display_name) ?? null;
    const key = `${connectionId ?? ''}\0${connectorKey ?? ''}`;
    const existing = byConnection.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byConnection.set(key, {
        connection_id: connectionId,
        connector_key: connectorKey,
        ...(displayName ? { display_name: displayName } : {}),
        count: 1,
      });
    }
  }
  return [...byConnection.values()];
}

function searchBodyHasMore(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.has_more === true) return true;
  if (body.data && typeof body.data === 'object' && body.data.has_more === true) return true;
  return false;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function mergeEventSubListEnvelopes(children, results) {
  const ok = results.find((r) => r.ok);
  if (!ok) return results[0];

  const merged = [];
  const warnings = [];

  results.forEach((r, i) => {
    const child = children[i];
    if (!r.ok) {
      warnings.push({
        code: 'source_unavailable',
        message: `Source ${child.member.connection_id || child.member.source?.id || child.member.grant_id} returned ${r.status}`,
        source: memberSourceTag(child.member),
      });
      return;
    }
    const rows = Array.isArray(r.body?.data) ? r.body.data : (Array.isArray(r.body) ? r.body : []);
    for (const row of rows) {
      merged.push({ ...row, source: memberSourceTag(child.member) });
    }
  });

  const baseBody = ok.body && typeof ok.body === 'object' ? { ...ok.body } : {};
  baseBody.data = merged;
  baseBody.meta = {
    ...(baseBody.meta || {}),
    package: { member_count: children.length, partial: warnings.length > 0 },
  };
  if (warnings.length > 0) {
    const existing = Array.isArray(baseBody.meta.warnings) ? baseBody.meta.warnings : [];
    baseBody.meta.warnings = [...existing, ...warnings];
  }
  return { ...ok, body: baseBody };
}
