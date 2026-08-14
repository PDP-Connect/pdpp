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

import {
  type HeaderParams,
  type QueryParams,
  type QueryValue,
  RsClient,
  type RsResponse,
} from "../../packages/mcp-server/src/rs-client.ts";
import { schemaSourceOptions } from "../operations/rs-schema-get/compact-view.ts";
import type { ConnectorSchemaItem } from "../operations/rs-schema-get/index.ts";

const AMBIGUOUS_CONNECTION_LIST_LIMIT = 12;
const EVENT_SUB_PATH_PATTERN = /^\/v1\/event-subscriptions\/([^/]+)$/;
const PARSABLE_POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const STREAM_PATH_PATTERN = /^\/v1\/streams\/([^/]+)/;
const TEST_EVENT_PATH_PATTERN = /^\/v1\/event-subscriptions\/([^/]+)\/test-event$/;
const TRAILING_SLASH_PATTERN = /\/$/;

type JsonObject = Record<string, unknown>;
type JsonRow = JsonObject;
type PackageRsResponse = RsResponse<unknown>;
type PackageRsFetch = typeof globalThis.fetch;
interface PackageRsMember {
  connection_id?: string | null;
  grant?: { streams?: Array<{ instance_ids?: string[]; name?: string }> };
  grant_id: string;
  source?: { display_name?: string; id?: string; [key: string]: unknown };
  token: string;
}
interface PackageChild {
  client: RsClient;
  member: PackageRsMember;
}
interface RequestOptions {
  body?: unknown;
  headers?: HeaderParams | undefined;
  query?: QueryParams | undefined;
}
interface PackageClientOptions {
  fetch?: PackageRsFetch;
  providerUrl: string;
  userAgent?: string;
}
type PackageClientFactoryOptions = PackageClientOptions & { accessToken: string };
type PackageClientPackageOptions = PackageClientOptions & { members: PackageRsMember[] };
type Route =
  | {
      kind:
        | "passthrough"
        | "fanout_schema"
        | "fanout_streams"
        | "fanout_search"
        | "fanout_event_sub_list"
        | "event_sub_create"
        | "source_required_get";
    }
  | { kind: "locate_event_sub" | "event_sub_test_event"; id: string };
type ChildLookup = { child: PackageChild } | { error: PackageRsResponse };
interface TypedErrorOptions {
  availableConnectionLimit?: number;
  availableConnections?: JsonRow[];
  includeAvailableConnections?: boolean;
  param?: string;
  retryWith?: string | null;
  status?: number;
  unavailableChildren?: Array<{ child: PackageChild; error: { code?: string; message?: string; status?: number } }>;
}
interface SourceTag {
  connection_id: string | null;
  connector_id: string | null;
  connector_key: string | null;
  display_name?: string;
  grant_id: string;
}
type SchemaEntry = { connections: JsonRow[]; stream: JsonRow } | { connections: JsonRow[] };
interface SchemaChildEnvelope {
  connectorItems: JsonRow[];
  entries: SchemaEntry[];
  member: PackageRsMember;
  sourceTag: SourceTag;
}
interface SchemaAggregate {
  connections: JsonRow[];
  connectorItems: JsonRow[];
  seenConnection: Set<string>;
  seenStream: Set<string>;
  streams: JsonRow[];
}
type SearchHit = JsonObject;
interface SchemaResponseContract {
  bearer: unknown;
  connectors: ConnectorSchemaItem[];
  object: "schema";
  [key: string]: unknown;
}
type SchemaSourceOption = ReturnType<typeof schemaSourceOptions>[number];

function rsRequestOptions({ body, headers, query }: RequestOptions): {
  body?: unknown;
  headers?: HeaderParams;
  query?: QueryParams;
} {
  return {
    ...(body === undefined ? {} : { body }),
    ...(headers === undefined ? {} : { headers }),
    ...(query === undefined ? {} : { query }),
  };
}

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
export function createRsClient({
  providerUrl,
  accessToken,
  fetch = globalThis.fetch,
  userAgent,
}: PackageClientFactoryOptions): RsClient {
  if (!providerUrl) {
    throw new TypeError("createRsClient requires providerUrl");
  }
  return new RsClient({ accessToken, fetch, providerUrl, ...(userAgent === undefined ? {} : { userAgent }) });
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
export function createPackageRsClient({
  providerUrl,
  members,
  fetch = globalThis.fetch,
  userAgent,
}: PackageClientPackageOptions): PackageRsClient {
  if (!providerUrl) {
    throw new TypeError("PackageRsClient requires providerUrl");
  }
  if (!Array.isArray(members) || members.length === 0) {
    throw new TypeError("PackageRsClient requires at least one active member");
  }

  // Build a child RsClient per member.
  const children = members.map((member) => ({
    client: new RsClient({
      accessToken: member.token,
      fetch,
      providerUrl,
      ...(userAgent === undefined ? {} : { userAgent }),
    }),
    member,
  }));

  return new PackageRsClient({ children, providerUrl });
}

class PackageRsClient {
  private readonly children: PackageChild[];
  private readonly providerUrl: string;

  constructor({ providerUrl, children }: { providerUrl: string; children: PackageChild[] }) {
    this.providerUrl = providerUrl.replace(TRAILING_SLASH_PATTERN, "");
    this.children = children;
  }

  // -------- public RsClient-compatible surface --------

  getJson(path: string, { query, headers }: RequestOptions = {}): Promise<PackageRsResponse> {
    const route = routeFor("GET", path);
    if (route.kind === "passthrough") {
      return this.passthroughGet(path, { headers, query });
    }
    if (route.kind === "fanout_schema") {
      return this.fanoutSchema({ headers, query });
    }
    if (route.kind === "fanout_streams") {
      return this.fanoutStreams({ headers, query });
    }
    if (route.kind === "fanout_search") {
      return this.fanoutSearch(path, { headers, query });
    }
    if (route.kind === "fanout_event_sub_list") {
      return this.fanoutEventSubList({ headers, query });
    }
    if (route.kind === "locate_event_sub") {
      return this.locateEventSubAndGet(route.id, { headers, query });
    }
    if (route.kind === "source_required_get") {
      return this.sourceRequiredJson("GET", path, { headers, query });
    }
    // Fallback: not all paths are mapped (e.g., streams resource template).
    return this.sourceRequiredJson("GET", path, { headers, query });
  }

  // Server-global public discovery is not scoped to a package child.
  // Reusing one child client preserves the RsClient-compatible response shape.
  passthroughGet(path: string, { query, headers }: RequestOptions = {}): Promise<PackageRsResponse> {
    const [child] = this.children;
    if (!child) {
      throw new Error("PackageRsClient has no active children");
    }
    return child.client.getJson(path, rsRequestOptions({ headers, query }));
  }

  getRaw(path: string, { query, headers }: RequestOptions = {}): Promise<PackageRsResponse> {
    // Blob / binary reads always require a source selector.
    return this.sourceRequiredRaw("GET", path, { headers, query });
  }

  postJson(path: string, { body, query, headers }: RequestOptions = {}): Promise<PackageRsResponse> {
    const route = routeFor("POST", path);
    if (route.kind === "event_sub_create") {
      return this.createEventSubForChild({ body, headers, query });
    }
    if (route.kind === "event_sub_test_event") {
      return this.locateEventSubAndForward(route.id, "POST", `${path}`, { body, headers, query });
    }
    return this.sourceRequiredJson("POST", path, { body, headers, query });
  }

  patchJson(path: string, { body, query, headers }: RequestOptions = {}): Promise<PackageRsResponse> {
    const route = routeFor("PATCH", path);
    if (route.kind === "locate_event_sub") {
      return this.locateEventSubAndForward(route.id, "PATCH", path, { body, headers, query });
    }
    return this.sourceRequiredJson("PATCH", path, { body, headers, query });
  }

  deleteJson(path: string, { query, headers }: RequestOptions = {}): Promise<PackageRsResponse> {
    const route = routeFor("DELETE", path);
    if (route.kind === "locate_event_sub") {
      return this.locateEventSubAndForward(route.id, "DELETE", path, { headers, query });
    }
    return this.sourceRequiredJson("DELETE", path, { headers, query });
  }

  buildUrl(path: string, query?: QueryParams): string {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, `${this.providerUrl}/`);
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const e of value) {
            url.searchParams.append(key, String(e));
          }
        } else if (typeof value === "object") {
          throw new TypeError(
            `query parameter '${key}' must be a scalar or array; encode nested query shapes explicitly before calling PackageRsClient`
          );
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }
    return url.toString();
  }

  // -------- fanout strategies --------

  async fanoutSchema({ query, headers }: RequestOptions): Promise<PackageRsResponse> {
    if (query?.connection_id) {
      const selected = this.selectChildOrError(query.connection_id, {
        sourceId: sourceIdFromQuery(query),
        streamNames: queryStringValues(query.stream),
      });
      if ("error" in selected) {
        return selected.error;
      }
      const result = await selected.child.client.getJson(
        "/v1/schema",
        rsRequestOptions({ headers, query: stripPackageSelectors(query) })
      );
      return mergeSchemaEnvelopes([selected.child], [result]);
    }

    if (query?.detail === "full") {
      if (!query?.stream) {
        return typedError(
          "invalid_request",
          'schema detail "full" requires `stream`; call /v1/schema?view=compact for global discovery, then /v1/schema?stream=<name>&connection_id=<cin>&detail=full for exhaustive detail.',
          this.children,
          { includeAvailableConnections: false, param: "detail", status: 400 }
        );
      }

      const preflightQuery: QueryParams = { ...query, view: "compact" };
      preflightQuery.detail = undefined;
      const preflight = await Promise.all(
        this.children.map(({ client }) =>
          client.getJson("/v1/schema", rsRequestOptions({ headers, query: preflightQuery }))
        )
      );
      const matches: Array<{ child: PackageChild; options: SchemaSourceOption[] }> = [];
      const available: SchemaSourceOption[] = [];
      preflight.forEach((result, index) => {
        if (!result.ok) {
          return;
        }
        const options = schemaSourceOptions(schemaDocument(responseBody(result)) as SchemaResponseContract, {
          stream: String(query.stream),
        });
        if (options.length === 0) {
          return;
        }
        const child = this.children[index];
        if (!child) {
          return;
        }
        matches.push({ child, options });
        available.push(...options);
      });
      if (available.length > 1) {
        return typedError(
          "ambiguous_schema_detail",
          `schema detail "full" for stream "${query.stream}" matches ${available.length} sources; retry with connection_id to fetch one source's exhaustive schema.`,
          this.children,
          {
            availableConnections: available.map((option) => ({ ...option })),
            param: "connection_id",
            retryWith: "connection_id",
          }
        );
      }
      if (matches.length === 1) {
        const [match] = matches;
        if (!match) {
          return typedError("not_found", "No schema source matched the requested stream", this.children);
        }
        const result = await match.child.client.getJson("/v1/schema", rsRequestOptions({ headers, query }));
        return mergeSchemaEnvelopes([match.child], [result]);
      }
    }

    const results = await Promise.all(
      this.children.map(({ client }) => client.getJson("/v1/schema", rsRequestOptions({ headers, query })))
    );
    return mergeSchemaEnvelopes(this.children, results);
  }

  async fanoutStreams({ query, headers }: RequestOptions): Promise<PackageRsResponse> {
    // If caller scoped to one connection_id, route to that child only.
    if (query?.connection_id) {
      const selected = this.selectChildOrError(query.connection_id, {
        sourceId: sourceIdFromQuery(query),
      });
      if ("error" in selected) {
        return selected.error;
      }
      return selected.child.client.getJson(
        "/v1/streams",
        rsRequestOptions({ headers, query: stripPackageSelectors(query) })
      );
    }

    const results = await Promise.all(
      this.children.map(({ client }) => client.getJson("/v1/streams", rsRequestOptions({ headers, query })))
    );
    return mergeListEnvelopes(this.children, results, "/v1/streams");
  }

  async fanoutSearch(path: string, { query, headers }: RequestOptions): Promise<PackageRsResponse> {
    if (query?.connection_id) {
      const selected = this.selectChildOrError(query.connection_id, {
        sourceId: sourceIdFromQuery(query),
        streamNames: requestedStreamsFromQuery(query),
      });
      if ("error" in selected) {
        return selected.error;
      }
      return selected.child.client.getJson(path, rsRequestOptions({ headers, query: stripPackageSelectors(query) }));
    }

    const results = await Promise.all(
      this.children.map(({ member, client }) => {
        const childQuery = searchQueryForChild(query, member);
        if (childQuery === null) {
          return emptySearchResponse();
        }
        return client.getJson(path, rsRequestOptions({ headers, query: childQuery }));
      })
    );
    return mergeSearchEnvelopes(this.children, results, path, query);
  }

  async sourceRequiredJson(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: RequestOptions
  ): Promise<PackageRsResponse> {
    const child = await this.resolveChildOrError(path, opts);
    if ("error" in child) {
      return child.error;
    }
    let clientMethod: "getJson" | "postJson" | "patchJson" | "deleteJson";
    if (method === "GET") {
      clientMethod = "getJson";
    } else if (method === "POST") {
      clientMethod = "postJson";
    } else if (method === "PATCH") {
      clientMethod = "patchJson";
    } else {
      clientMethod = "deleteJson";
    }
    return child.child.client[clientMethod](
      path,
      rsRequestOptions({ ...opts, query: stripPackageSelectors(opts.query) })
    );
  }

  async sourceRequiredRaw(_method: "GET", path: string, opts: RequestOptions): Promise<PackageRsResponse> {
    const child = await this.resolveChildOrError(path, opts);
    if ("error" in child) {
      return child.error;
    }
    return child.child.client.getRaw(path, rsRequestOptions({ ...opts, query: stripPackageSelectors(opts.query) }));
  }

  async resolveChildOrError(path: string, { query }: RequestOptions): Promise<ChildLookup> {
    const connectionId = query?.connection_id;
    if (connectionId) {
      return this.selectChildOrError(connectionId, {
        sourceId: sourceIdFromQuery(query),
        streamNames: queryStringValues(streamNameFromPath(path)),
      });
    }
    if (this.children.length === 1 && this.children[0]) {
      return { child: this.children[0] };
    }
    return {
      error: await this.ambiguousConnectionError(
        "This hosted MCP package contains multiple sources. Pass `connection_id` to select one. Use `schema` to discover available connections."
      ),
    };
  }

  ambiguousConnectionError(message: string): Promise<PackageRsResponse> {
    return Promise.resolve(typedError("ambiguous_connection", message, this.children));
  }

  selectChildOrError(
    connectionId: QueryValue,
    { sourceId = null, streamNames = [] }: { sourceId?: string | null; streamNames?: string[] } = {}
  ): ChildLookup {
    const matches = matchingChildrenByConnectionId(this.children, connectionId, streamNames, sourceId);
    if (matches.length === 1 && matches[0]) {
      return { child: matches[0] };
    }
    if (matches.length > 1) {
      return {
        error: typedError(
          "ambiguous_connection",
          `connection_id "${String(connectionId)}" exists under multiple package sources; pass source_id to select one`,
          matches,
          { param: "source_id", retryWith: "source_id" }
        ),
      };
    }
    return {
      error: typedError(
        "not_found",
        `connection_id "${String(connectionId)}" is not part of the selected package source and stream`,
        this.children
      ),
    };
  }

  // -------- event subscriptions --------

  async createEventSubForChild({ body, query, headers }: RequestOptions): Promise<PackageRsResponse> {
    // Selector can come from query (?connection_id) OR top-level body.connection_id.
    const sel =
      query?.connection_id ??
      (isRecord(body) && typeof body.connection_id === "string" ? body.connection_id : undefined);
    let child: PackageChild | undefined;
    if (sel) {
      const selected = this.selectChildOrError(sel, {
        sourceId: sourceIdFromRequest(query, body),
      });
      if ("error" in selected) {
        return selected.error;
      }
      ({ child } = selected);
    } else if (this.children.length === 1) {
      [child] = this.children;
    } else {
      return await this.ambiguousConnectionError(
        "This hosted MCP package contains multiple sources. Pass `connection_id` when creating an event subscription so it binds to exactly one child grant."
      );
    }
    const childBody: JsonObject = isRecord(body) ? { ...body } : {};
    childBody.connection_id = undefined;
    childBody.connector_id = undefined;
    childBody.source_id = undefined;
    if (!child) {
      throw new Error("PackageRsClient has no active children");
    }
    return child.client.postJson(
      "/v1/event-subscriptions",
      rsRequestOptions({ body: childBody, headers, query: stripPackageSelectors(query, { connectionId: true }) })
    );
  }

  async fanoutEventSubList({ query, headers }: RequestOptions): Promise<PackageRsResponse> {
    const results = await Promise.all(
      this.children.map(({ client }) => client.getJson("/v1/event-subscriptions", rsRequestOptions({ headers, query })))
    );
    return mergeEventSubListEnvelopes(this.children, results);
  }

  async locateEventSubAndGet(id: string, opts: RequestOptions): Promise<PackageRsResponse> {
    const found = await this.locateEventSubOwner(id);
    if ("error" in found) {
      return found.error;
    }
    return found.child.client.getJson(`/v1/event-subscriptions/${encodeURIComponent(id)}`, rsRequestOptions(opts));
  }

  async locateEventSubAndForward(
    id: string,
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    opts: RequestOptions
  ): Promise<PackageRsResponse> {
    const found = await this.locateEventSubOwner(id);
    if ("error" in found) {
      return found.error;
    }
    let clientMethod: "postJson" | "patchJson" | "deleteJson";
    if (method === "POST") {
      clientMethod = "postJson";
    } else if (method === "PATCH") {
      clientMethod = "patchJson";
    } else {
      clientMethod = "deleteJson";
    }
    return found.child.client[clientMethod](path, rsRequestOptions(opts));
  }

  async locateEventSubOwner(id: string): Promise<ChildLookup> {
    const probes = await Promise.all(
      this.children.map(async ({ member, client }) => {
        try {
          const r = await client.getJson(`/v1/event-subscriptions/${encodeURIComponent(id)}`);
          return { client, member, ok: r.ok && r.status === 200 };
        } catch {
          return { client, member, ok: false };
        }
      })
    );
    const owner = probes.find((p) => p.ok);
    if (owner) {
      return { child: { client: owner.client, member: owner.member } };
    }
    return {
      error: {
        contentType: "application/json",
        error: {
          code: "not_found",
          message: `event subscription "${id}" is not owned by any active member of this hosted MCP package`,
          type: "not_found",
        },
        ok: false,
        requestId: null,
        status: 404,
      },
    };
  }
}

// -------- routing classifier --------

function routeFor(method: string, path: string): Route {
  const clean = path.split("?")[0] ?? path;

  if (method === "GET" && clean === "/.well-known/oauth-protected-resource") {
    return { kind: "passthrough" };
  }

  if (method === "GET" && clean === "/v1/schema") {
    return { kind: "fanout_schema" };
  }
  if (method === "GET" && clean === "/v1/streams") {
    return { kind: "fanout_streams" };
  }
  if (
    method === "GET" &&
    (clean === "/v1/search" || clean === "/v1/search/semantic" || clean === "/v1/search/hybrid")
  ) {
    return { kind: "fanout_search" };
  }
  if (method === "GET" && clean === "/v1/event-subscriptions") {
    return { kind: "fanout_event_sub_list" };
  }

  if (method === "POST" && clean === "/v1/event-subscriptions") {
    return { kind: "event_sub_create" };
  }

  const eventSubMatch = clean.match(EVENT_SUB_PATH_PATTERN);
  if (eventSubMatch) {
    return { id: decodeURIComponent(eventSubMatch[1] ?? ""), kind: "locate_event_sub" };
  }
  const testEventMatch = clean.match(TEST_EVENT_PATH_PATTERN);
  if (testEventMatch && method === "POST") {
    return { id: decodeURIComponent(testEventMatch[1] ?? ""), kind: "event_sub_test_event" };
  }

  return { kind: "source_required_get" };
}

// -------- selectors --------

function matchingChildrenByConnectionId(
  children: PackageChild[],
  connectionId: string | QueryValue,
  streamNames: string[] = [],
  sourceId: string | null = null
): PackageChild[] {
  if (!connectionId) {
    return [];
  }
  return children.filter(
    ({ member }) =>
      (!sourceId || member.source?.id === sourceId) && grantedInstanceIds(member, streamNames).has(String(connectionId))
  );
}

function grantedInstanceIds(member: PackageRsMember, streamNames: string[] = []): Set<string> {
  const requestedStreams = new Set(streamNames);
  const streams = Array.isArray(member.grant?.streams) ? member.grant.streams : [];
  return new Set(
    streams
      .filter(
        (stream) =>
          requestedStreams.size === 0 || (typeof stream.name === "string" && requestedStreams.has(stream.name))
      )
      .flatMap((stream) => (Array.isArray(stream.instance_ids) ? stream.instance_ids : []))
      .filter((instanceId) => typeof instanceId === "string" && instanceId.length > 0)
  );
}

function streamNameFromPath(path: string): string | null {
  const match = path.split("?")[0]?.match(STREAM_PATH_PATTERN);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function stripPackageSelectors(
  query: QueryParams | undefined,
  { connectionId = false }: { connectionId?: boolean } = {}
): QueryParams | undefined {
  if (!query || typeof query !== "object") {
    return query;
  }
  const { connector_id: _connectorId, source_id: _sourceId, ...rest } = query;
  if (connectionId) {
    rest.connection_id = undefined;
  }
  return rest;
}

function sourceIdFromQuery(query: QueryParams | undefined): string | null {
  return firstNonEmptyString(query?.source_id, query?.connector_id) ?? null;
}

function sourceIdFromRequest(query: QueryParams | undefined, body: unknown): string | null {
  const requestBody = isRecord(body) ? body : {};
  return (
    firstNonEmptyString(query?.source_id, query?.connector_id, requestBody.source_id, requestBody.connector_id) ?? null
  );
}

function queryStringValues(value: QueryValue | string | null | undefined): string[] {
  const values: string[] = [];
  collectStreamQueryValues(values, value as QueryValue);
  return values;
}

function searchQueryForChild(query: QueryParams | undefined, member: PackageRsMember): QueryParams | null | undefined {
  const requested = requestedStreamsFromQuery(query);
  if (requested.length === 0) {
    return query;
  }
  const granted = grantedStreamNames(member);
  if (!granted) {
    return query;
  }

  const selected = granted.has("*") ? requested : requested.filter((stream) => granted.has(stream));
  if (selected.length === 0) {
    return null;
  }

  const next: QueryParams = query && typeof query === "object" ? { ...query } : {};
  next.streams = undefined;
  next["streams[]"] = undefined;
  next.streams = selected;
  return next;
}

function requestedStreamsFromQuery(query: QueryParams | undefined): string[] {
  if (!query || typeof query !== "object") {
    return [];
  }
  const values: string[] = [];
  collectStreamQueryValues(values, query.streams);
  collectStreamQueryValues(values, query["streams[]"]);

  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function collectStreamQueryValues(out: string[], value: QueryValue): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStreamQueryValues(out, entry);
    }
    return;
  }
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    out.push(trimmed);
  }
}

function grantedStreamNames(member: PackageRsMember): Set<string> | null {
  const streams = member.grant?.streams;
  if (!Array.isArray(streams)) {
    return null;
  }
  const names = streams
    .map((stream) => (typeof stream?.name === "string" ? stream.name.trim() : ""))
    .filter((name) => name.length > 0);
  return new Set(names);
}

function emptySearchResponse(): PackageRsResponse {
  return {
    body: { data: [], has_more: false, object: "list" },
    contentType: "application/json",
    ok: true,
    requestId: null,
    status: 200,
  };
}

// -------- envelope helpers --------

function memberSourceTag(member: PackageRsMember): SourceTag {
  const connectorKey = member.source?.id ?? null;
  return {
    connection_id: member.connection_id ?? null,
    connector_id: connectorKey,
    connector_key: connectorKey,
    grant_id: member.grant_id,
    ...(member.source?.display_name ? { display_name: member.source.display_name } : {}),
  };
}

function availableConnectionsList(
  children: PackageChild[],
  { limit = Number.POSITIVE_INFINITY }: { limit?: number } = {}
): JsonRow[] {
  return children.slice(0, limit).map(({ member }) => ({
    connection_id: member.connection_id ?? null,
    connector_key: member.source?.id ?? null,
    grant_id: member.grant_id,
    ...(member.source?.display_name ? { display_name: member.source.display_name } : {}),
  }));
}

function unavailableConnectionsList(
  entries: Array<{ child: PackageChild; error: { code?: string; message?: string; status?: number } }>
): JsonRow[] {
  return entries.map(({ child, error }) => ({
    ...availableConnectionsList([child])[0],
    error: {
      code: error?.code ?? "source_unavailable",
      message: error?.message ?? "Source is unavailable",
    },
    status: error?.status ?? null,
  }));
}

function typedError(
  code: string,
  message: string,
  children: PackageChild[],
  options: TypedErrorOptions = {}
): PackageRsResponse {
  const unavailableConnections = unavailableConnectionsList(options.unavailableChildren ?? []);
  const limit = options.availableConnectionLimit ?? AMBIGUOUS_CONNECTION_LIST_LIMIT;
  let availableConnections: JsonRow[];
  const { availableConnections: configuredConnections } = options;
  if (Array.isArray(configuredConnections)) {
    availableConnections = configuredConnections;
  } else if (options.includeAvailableConnections === false) {
    availableConnections = [];
  } else {
    availableConnections = availableConnectionsList(children, { limit });
  }
  const error: JsonObject = {
    code,
    message,
    type: code,
    ...(options.param ? { param: options.param } : {}),
    ...(availableConnections.length > 0 ? { available_connections: availableConnections } : {}),
    ...(options.includeAvailableConnections === false ? {} : { available_connection_count: children.length }),
    ...(options.retryWith === null ? {} : { retry_with: options.retryWith ?? "connection_id" }),
  };
  if (
    options.includeAvailableConnections !== false &&
    !Array.isArray(options.availableConnections) &&
    availableConnections.length < children.length
  ) {
    error.available_connections_truncated = true;
    error.available_connections_omitted = children.length - availableConnections.length;
    error.discovery_hint = "Call `schema` for the full granted connection index before retrying with `connection_id`.";
  }
  if (unavailableConnections.length > 0) {
    error.unavailable_connections = unavailableConnections;
  }
  return {
    contentType: "application/json",
    error,
    ok: false,
    requestId: null,
    status: options.status ?? (code === "not_found" ? 404 : 409),
  };
}

function schemaDocument(body: unknown): JsonObject {
  if (isRecord(body) && isRecord(body.data)) {
    return body.data;
  }
  return isRecord(body) ? body : {};
}

function responseBody(response: PackageRsResponse): unknown {
  return response.ok ? response.body : undefined;
}

function rowsFromResponseBody(body: unknown): JsonRow[] {
  if (isRecord(body)) {
    return rowsFromUnknown(body.data);
  }
  if (Array.isArray(body)) {
    return rowsFromUnknown(body);
  }
  return [];
}

function firstResponse(results: PackageRsResponse[]): PackageRsResponse {
  const [first] = results;
  if (!first) {
    throw new Error("PackageRsClient received no child responses");
  }
  return first;
}

function normalizeSchemaChildEnvelope(child: PackageChild, result: PackageRsResponse): SchemaChildEnvelope {
  const rawBody = responseBody(result);
  const resultBody: JsonObject = isRecord(rawBody) ? rawBody : {};
  const childData = isRecord(resultBody.data) ? resultBody.data : resultBody;
  const sourceTag = memberSourceTag(child.member);
  const connectorItems: JsonRow[] = [];
  const entries: SchemaEntry[] = [];
  const connectors = rowsFromUnknown(childData.connectors);

  if (connectors.length > 0) {
    for (const connector of connectors) {
      const connectorSource = isRecord(connector.source) ? { ...sourceTag, ...connector.source } : sourceTag;
      connectorItems.push({ ...connector, source: connectorSource });
      for (const stream of rowsFromUnknown(connector.streams)) {
        entries.push({
          connections: rowsFromUnknown(stream.granted_connections),
          stream,
        });
      }
    }
  } else {
    for (const stream of rowsFromUnknown(childData.streams)) {
      entries.push({ connections: [], stream });
    }
    for (const connection of rowsFromUnknown(childData.granted_connections)) {
      entries.push({ connections: [connection] });
    }
  }

  return { connectorItems, entries, member: child.member, sourceTag };
}

function aggregateSchemaChildEnvelope(aggregate: SchemaAggregate, envelope: SchemaChildEnvelope): void {
  for (const connectorItem of envelope.connectorItems) {
    aggregate.connectorItems.push(connectorItem);
  }
  for (const entry of envelope.entries) {
    if ("stream" in entry) {
      const key = `${entry.stream.name}::${envelope.member.grant_id}::${envelope.member.connection_id}`;
      if (aggregate.seenStream.has(key)) {
        continue;
      }
      aggregate.seenStream.add(key);
      aggregate.streams.push({ ...entry.stream, source: envelope.sourceTag });
    }
    for (const connection of entry.connections) {
      const key = `${connection?.connection_id ?? ""}::${envelope.member.grant_id}`;
      if (aggregate.seenConnection.has(key)) {
        continue;
      }
      aggregate.seenConnection.add(key);
      aggregate.connections.push({ ...connection, source: envelope.sourceTag });
    }
  }
}

function mergeSchemaEnvelopes(children: PackageChild[], results: PackageRsResponse[]): PackageRsResponse {
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
  if (!ok) {
    return firstResponse(results);
  }

  const rawBody = responseBody(ok);
  const baseBody: JsonObject = isRecord(rawBody) ? { ...rawBody } : { data: {} };
  const data: JsonObject = isRecord(baseBody.data) ? { ...baseBody.data } : {};

  const aggregate: SchemaAggregate = {
    connections: [],
    connectorItems: [],
    seenConnection: new Set(),
    seenStream: new Set(),
    streams: [],
  };

  results.forEach((r, i) => {
    if (!r.ok) {
      return;
    }
    const child = children[i];
    if (!child) {
      return;
    }
    aggregateSchemaChildEnvelope(aggregate, normalizeSchemaChildEnvelope(child, r));
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

function mergeListEnvelopes(children: PackageChild[], results: PackageRsResponse[], _path: string): PackageRsResponse {
  // For /v1/streams: shape is { data: [...] }. Concatenate; tag each row.
  const ok = results.find((r) => r.ok);
  if (!ok) {
    return firstResponse(results);
  }

  const merged: JsonRow[] = [];
  const meta: JsonObject = { package: { member_count: children.length, partial: false } };
  const warnings: JsonRow[] = [];

  results.forEach((r, i) => {
    const child = children[i];
    if (!child) {
      return;
    }
    if (!r.ok) {
      const packageMeta = isRecord(meta.package) ? meta.package : {};
      packageMeta.partial = true;
      meta.package = packageMeta;
      warnings.push({
        code: "source_unavailable",
        message: `Source ${child.member.connection_id || child.member.source?.id || child.member.grant_id} returned ${r.status}`,
        source: memberSourceTag(child.member),
      });
      return;
    }
    const body = responseBody(r);
    const rows = rowsFromResponseBody(body);
    for (const row of rows) {
      merged.push({ ...row, source: memberSourceTag(child.member) });
    }
  });

  const rawBody = responseBody(ok);
  const baseBody: JsonObject = isRecord(rawBody) ? { ...rawBody } : {};
  baseBody.data = merged;
  baseBody.meta = { ...(baseBody.meta || {}), ...meta };
  if (warnings.length > 0) {
    const warningMeta = isRecord(baseBody.meta) ? baseBody.meta : {};
    warningMeta.warnings = [...(Array.isArray(warningMeta.warnings) ? warningMeta.warnings : []), ...warnings];
    baseBody.meta = warningMeta;
  }
  return { ...ok, body: baseBody };
}

function placeSearchHitsInEnvelope(baseBody: JsonObject, limitedHits: SearchHit[], totalScanned: number): void {
  const data = isRecord(baseBody.data) ? baseBody.data : null;
  if (Array.isArray(baseBody.data)) {
    baseBody.data = limitedHits;
  } else if (data && Array.isArray(data.data)) {
    baseBody.data = { ...data, data: limitedHits };
  } else if (data && Array.isArray(data.results)) {
    baseBody.data = { ...data, results: limitedHits, ...(totalScanned > 0 ? { scanned: totalScanned } : {}) };
  } else if (Array.isArray(baseBody.results)) {
    baseBody.results = limitedHits;
  } else {
    baseBody.data = { results: limitedHits };
  }
}

function mergeSearchEnvelopes(
  children: PackageChild[],
  results: PackageRsResponse[],
  _path: string,
  query: QueryParams = {}
): PackageRsResponse {
  const ok = results.find((r) => r.ok);
  if (!ok) {
    return firstResponse(results);
  }

  const requestedLimit = parsePositiveInt(query.limit) ?? 25;
  const mergedHits: SearchHit[] = [];
  const warnings: JsonRow[] = [];
  let totalScanned = 0;
  let childHasMore = false;

  results.forEach((r, i) => {
    const child = children[i];
    if (!child) {
      return;
    }
    if (!r.ok) {
      warnings.push({
        code: "source_unavailable",
        message: `Source ${child.member.connection_id || child.member.source?.id || child.member.grant_id} returned ${r.status}`,
        source: memberSourceTag(child.member),
      });
      return;
    }
    const hits = extractSearchHits(responseBody(r));
    for (const hit of hits) {
      mergedHits.push(decorateSearchHitWithSource(hit, memberSourceTag(child.member)));
    }
    const body = responseBody(r);
    const data = isRecord(body) && isRecord(body.data) ? body.data : {};
    if (typeof data.scanned === "number") {
      totalScanned += data.scanned;
    }
    if (searchBodyHasMore(body)) {
      childHasMore = true;
    }
  });

  const dedupedHits = dedupeSearchHits(mergedHits);
  const limitedHits = dedupedHits.slice(0, requestedLimit);
  const truncated = dedupedHits.length > limitedHits.length;
  const sourceMix = sourceMixForHits(limitedHits);
  const rawBody = responseBody(ok);
  const baseBody: JsonObject = isRecord(rawBody) ? { ...rawBody } : {};
  placeSearchHitsInEnvelope(baseBody, limitedHits, totalScanned);
  baseBody.has_more = truncated || childHasMore || baseBody.has_more === true;
  baseBody.meta = {
    ...(baseBody.meta || {}),
    package: {
      fanout_limit: requestedLimit,
      member_count: children.length,
      merged_hit_count: dedupedHits.length,
      partial: warnings.length > 0,
      returned_hit_count: limitedHits.length,
      source_mix: sourceMix,
    },
  };
  if (warnings.length > 0) {
    const warningMeta = isRecord(baseBody.meta) ? baseBody.meta : {};
    warningMeta.warnings = [...(Array.isArray(warningMeta.warnings) ? warningMeta.warnings : []), ...warnings];
    baseBody.meta = warningMeta;
  }
  return { ...ok, body: baseBody };
}

function extractSearchHits(body: unknown): SearchHit[] {
  if (!isRecord(body)) {
    return [];
  }
  if (Array.isArray(body.results)) {
    return rowsFromUnknown(body.results);
  }
  if (Array.isArray(body.data)) {
    return rowsFromUnknown(body.data);
  }
  if (isRecord(body.data) && Array.isArray(body.data.data)) {
    return rowsFromUnknown(body.data.data);
  }
  if (isRecord(body.data) && Array.isArray(body.data.results)) {
    return rowsFromUnknown(body.data.results);
  }
  return [];
}

function parsePositiveInt(value: QueryValue): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && PARSABLE_POSITIVE_INTEGER_PATTERN.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

function decorateSearchHitWithSource(hit: SearchHit, fallbackSource: SourceTag): SearchHit {
  const source = isRecord(hit.source) ? { ...fallbackSource, ...hit.source } : fallbackSource;
  return {
    ...hit,
    connection_id: firstNonEmptyString(hit.connection_id, hit.connector_instance_id, source.connection_id),
    connector_key: firstNonEmptyString(hit.connector_key, hit.connector_id, source.connector_key, source.connector_id),
    source,
    ...(firstNonEmptyString(hit.display_name, source.display_name)
      ? { display_name: firstNonEmptyString(hit.display_name, source.display_name) }
      : {}),
  };
}

function dedupeSearchHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const key = searchHitDedupeKey(hit);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function searchHitDedupeKey(hit: SearchHit): string {
  const source = isRecord(hit.source) ? hit.source : {};
  return [
    firstNonEmptyString(hit.connection_id, source.connection_id),
    firstNonEmptyString(hit.connector_key, hit.connector_id, source.connector_key, source.connector_id),
    firstNonEmptyString(hit.stream, hit.stream_name, hit.streamName),
    firstNonEmptyString(hit.record_key, hit.recordKey, hit.record_id, hit.recordId, hit.id, hit.url),
  ]
    .map((part) => part ?? "")
    .join("\0");
}

function sourceMixForHits(hits: SearchHit[]): JsonRow[] {
  const byConnection = new Map();
  for (const hit of hits) {
    const source = isRecord(hit.source) ? hit.source : {};
    const connectionId = firstNonEmptyString(hit.connection_id, source.connection_id) ?? null;
    const connectorKey =
      firstNonEmptyString(hit.connector_key, hit.connector_id, source.connector_key, source.connector_id) ?? null;
    const displayName = firstNonEmptyString(hit.display_name, source.display_name) ?? null;
    const key = `${connectionId ?? ""}\0${connectorKey ?? ""}`;
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

function searchBodyHasMore(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }
  if (body.has_more === true) {
    return true;
  }
  if (isRecord(body.data) && body.data.has_more === true) {
    return true;
  }
  return false;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  let first: string | undefined;
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      first = value;
      break;
    }
  }
  return first;
}

function mergeEventSubListEnvelopes(children: PackageChild[], results: PackageRsResponse[]): PackageRsResponse {
  const ok = results.find((r) => r.ok);
  if (!ok) {
    return firstResponse(results);
  }

  const merged: JsonRow[] = [];
  const warnings: JsonRow[] = [];

  results.forEach((r, i) => {
    const child = children[i];
    if (!child) {
      return;
    }
    if (!r.ok) {
      warnings.push({
        code: "source_unavailable",
        message: `Source ${child.member.connection_id || child.member.source?.id || child.member.grant_id} returned ${r.status}`,
        source: memberSourceTag(child.member),
      });
      return;
    }
    const body = responseBody(r);
    const rows = rowsFromResponseBody(body);
    for (const row of rows) {
      merged.push({ ...row, source: memberSourceTag(child.member) });
    }
  });

  const rawBody = responseBody(ok);
  const baseBody: JsonObject = isRecord(rawBody) ? { ...rawBody } : {};
  baseBody.data = merged;
  baseBody.meta = {
    ...(baseBody.meta || {}),
    package: { member_count: children.length, partial: warnings.length > 0 },
  };
  if (warnings.length > 0) {
    const warningMeta = isRecord(baseBody.meta) ? baseBody.meta : {};
    warningMeta.warnings = [...(Array.isArray(warningMeta.warnings) ? warningMeta.warnings : []), ...warnings];
    baseBody.meta = warningMeta;
  }
  return { ...ok, body: baseBody };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowsFromUnknown(value: unknown): JsonRow[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
