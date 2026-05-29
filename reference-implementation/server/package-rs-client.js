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
 *   - `GET /v1/search[/...]`        — fan out, merge results (each hit
 *                                     already carries connection_id).
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

const PACKAGE_INTROSPECTION_PATH = null;

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
        else if (typeof value === 'object') url.searchParams.append(key, JSON.stringify(value));
        else url.searchParams.append(key, String(value));
      }
    }
    return url.toString();
  }

  // -------- fanout strategies --------

  async fanoutSchema({ query, headers }) {
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
      this.children.map(({ client }) => client.getJson(path, { query, headers })),
    );
    return mergeSearchEnvelopes(this.children, results, path);
  }

  async sourceRequiredJson(method, path, opts) {
    const child = this.resolveChildOrError(opts);
    if (child.error) return child.error;
    return child.client[method === 'GET' ? 'getJson' : method === 'POST' ? 'postJson' : method === 'PATCH' ? 'patchJson' : 'deleteJson'](
      path,
      opts,
    );
  }

  async sourceRequiredRaw(_method, path, opts) {
    const child = this.resolveChildOrError(opts);
    if (child.error) return child.error;
    return child.client.getRaw(path, opts);
  }

  resolveChildOrError({ query }) {
    const connectionId = query?.connection_id;
    if (connectionId) {
      const child = pickChildByConnectionId(this.children, connectionId);
      if (child) return child;
      return { error: typedError('not_found', `connection_id "${connectionId}" is not part of this package`, this.children) };
    }
    if (this.children.length === 1) return this.children[0];
    return { error: typedError('ambiguous_connection', 'This hosted MCP package contains multiple sources. Pass `connection_id` to select one. Use `list_streams` or `schema` to discover available connections.', this.children) };
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
      return typedError('ambiguous_connection', 'This hosted MCP package contains multiple sources. Pass `connection_id` when creating an event subscription so it binds to exactly one child grant.', this.children);
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

// -------- envelope helpers --------

function memberSourceTag(member) {
  return {
    grant_id: member.grant_id,
    connector_key: member.source?.id ?? null,
    connection_id: member.connection_id ?? null,
    ...(member.source?.display_name ? { display_name: member.source.display_name } : {}),
  };
}

function availableConnectionsList(children) {
  return children.map(({ member }) => ({
    grant_id: member.grant_id,
    connector_key: member.source?.id ?? null,
    connection_id: member.connection_id ?? null,
    ...(member.source?.display_name ? { display_name: member.source.display_name } : {}),
  }));
}

function typedError(code, message, children) {
  return {
    ok: false,
    status: code === 'not_found' ? 404 : 409,
    error: {
      type: code,
      code,
      message,
      available_connections: availableConnectionsList(children),
      retry_with: 'connection_id',
    },
    requestId: null,
    contentType: 'application/json',
  };
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

  const allStreams = [];
  const allConnections = [];
  const allConnectorItems = [];
  const seenStream = new Set();
  const seenConnection = new Set();

  results.forEach((r, i) => {
    if (!r.ok) return;
    const child = children[i];
    const childData = r.body?.data && typeof r.body.data === 'object'
      ? r.body.data
      : (r.body && typeof r.body === 'object' ? r.body : {});

    // Canonical shape: childData.connectors is an array of connector items
    // each carrying its own streams[]. Older / hand-built shapes may put
    // streams directly on `childData.streams`. Accept both.
    const connectorItems = Array.isArray(childData.connectors) ? childData.connectors : [];
    const sourceTag = memberSourceTag(child.member);

    if (connectorItems.length > 0) {
      for (const item of connectorItems) {
        allConnectorItems.push({ ...item, source: item?.source ?? sourceTag });
        const itemStreams = Array.isArray(item?.streams) ? item.streams : [];
        for (const s of itemStreams) {
          const key = `${s?.name ?? ''}::${child.member.grant_id}::${child.member.connection_id ?? ''}`;
          if (seenStream.has(key)) continue;
          seenStream.add(key);
          allStreams.push({ ...s, source: sourceTag });
          const perStreamGranted = Array.isArray(s?.granted_connections) ? s.granted_connections : [];
          for (const c of perStreamGranted) {
            const ck = `${c?.connection_id ?? ''}::${child.member.grant_id}`;
            if (seenConnection.has(ck)) continue;
            seenConnection.add(ck);
            allConnections.push({ ...c, source: sourceTag });
          }
        }
      }
    } else {
      const flatStreams = Array.isArray(childData.streams) ? childData.streams : [];
      for (const s of flatStreams) {
        const key = `${s?.name ?? ''}::${child.member.grant_id}::${child.member.connection_id ?? ''}`;
        if (seenStream.has(key)) continue;
        seenStream.add(key);
        allStreams.push({ ...s, source: sourceTag });
      }
      const flatGranted = Array.isArray(childData.granted_connections) ? childData.granted_connections : [];
      for (const c of flatGranted) {
        const ck = `${c?.connection_id ?? ''}::${child.member.grant_id}`;
        if (seenConnection.has(ck)) continue;
        seenConnection.add(ck);
        allConnections.push({ ...c, source: sourceTag });
      }
    }
  });

  data.streams = allStreams;
  data.granted_connections = allConnections;
  if (allConnectorItems.length > 0) {
    data.connectors = allConnectorItems;
    data.connector_count = allConnectorItems.length;
    data.stream_count = allStreams.length;
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

function mergeSearchEnvelopes(children, results, _path) {
  const ok = results.find((r) => r.ok);
  if (!ok) return results[0];

  const mergedHits = [];
  const warnings = [];
  let totalScanned = 0;

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
      mergedHits.push({ ...hit, source: hit.source || memberSourceTag(child.member) });
    }
    if (typeof r.body?.data?.scanned === 'number') totalScanned += r.body.data.scanned;
  });

  const baseBody = ok.body && typeof ok.body === 'object' ? { ...ok.body } : {};
  if (baseBody.data && typeof baseBody.data === 'object' && Array.isArray(baseBody.data.results)) {
    baseBody.data = { ...baseBody.data, results: mergedHits };
    if (totalScanned > 0) baseBody.data.scanned = totalScanned;
  } else if (Array.isArray(baseBody.results)) {
    baseBody.results = mergedHits;
  } else {
    baseBody.data = { results: mergedHits };
  }
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

function extractSearchHits(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.results)) return body.results;
  if (body.data && typeof body.data === 'object' && Array.isArray(body.data.results)) return body.data.results;
  return [];
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
