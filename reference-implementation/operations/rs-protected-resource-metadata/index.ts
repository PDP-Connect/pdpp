// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `rs.protected-resource-metadata` operation.
 *
 * Owns the composition decisions behind the RFC 9728 protected-resource
 * metadata document served at
 * `GET /.well-known/oauth-protected-resource` on the resource server.
 *
 * Composition rules (preserved from the previous inline route):
 * - `lexical_retrieval` capability is published unless the host
 *   explicitly suppresses it (`lexicalRetrievalSupported === false`) or
 *   overrides the shape (`lexicalRetrievalCapability`).
 * - `semantic_retrieval` capability is published only when a real
 *   embedding backend is available AND the host has not suppressed it.
 *   The host computes the live capability shape (model, dimensions,
 *   distance metric, index state, etc.) and passes it in.
 * - `hybrid_retrieval` capability is published only when BOTH lexical
 *   AND semantic retrieval are advertised with `supported: true`, and
 *   the host has not suppressed it.
 * - Discovery hints always include schema/query base/connectors/streams
 *   pointers and a fixed `changes_since_bootstrap: 'beginning'` plus
 *   `blob_indirection` value. Search and hybrid pagination hints are
 *   only added when the matching capability is advertised. The polyfill
 *   `owner_polyfill_requires_source_kind_connector` hint is added only when the
 *   server is NOT in native single-source mode.
 *
 * Boundary rules (see openspec/changes/complete-reference-operation-refactor):
 * - This module SHALL NOT import Fastify, Express, Next, SQLite,
 *   Postgres, a raw SQL handle, sandbox modules, the records module,
 *   `server/index.js`, `server/metadata.ts` (host wire-shape builder),
 *   the embedding backend, or `process` / `process.env`.
 * - The host resolves URLs, the live semantic backend advertisement,
 *   the agent-discovery block, the exact wire-shape projection, and the
 *   response writing. The operation only decides what to compose.
 */

export interface RsProtectedResourceMetadataLexicalCapability {
  readonly supported?: boolean;
  readonly [extra: string]: unknown;
}

export interface RsProtectedResourceMetadataSemanticCapability {
  readonly supported?: boolean;
  readonly [extra: string]: unknown;
}

export interface RsProtectedResourceMetadataHybridCapability {
  readonly supported?: boolean;
  readonly cursor_supported?: boolean;
  readonly [extra: string]: unknown;
}

export interface RsProtectedResourceMetadataDiscoveryHints {
  readonly schema_endpoint: "/v1/schema";
  readonly query_base: "/v1";
  readonly connectors_endpoint: "/v1/connectors";
  readonly streams_endpoint_template: "/v1/streams/{stream}";
  readonly aggregate: { readonly endpoint_template: "/v1/streams/{stream}/aggregate" };
  readonly changes_since_bootstrap: "beginning";
  readonly blob_indirection: "data.blob_ref.fetch_url";
  readonly search?: {
    readonly endpoint: string;
    readonly scope_param: "streams[]";
    readonly filter_requires_single_stream: true;
  };
  readonly hybrid_pagination_supported?: boolean;
  readonly owner_polyfill_requires_source_kind_connector?: true;
}

export interface RsProtectedResourceMetadataClientEventSubscriptionsCapability {
  readonly supported?: boolean;
  readonly [extra: string]: unknown;
}

export interface RsProtectedResourceMetadataCapabilities {
  lexical_retrieval?: RsProtectedResourceMetadataLexicalCapability;
  semantic_retrieval?: RsProtectedResourceMetadataSemanticCapability;
  hybrid_retrieval?: RsProtectedResourceMetadataHybridCapability;
  client_event_subscriptions?: RsProtectedResourceMetadataClientEventSubscriptionsCapability;
}

export interface RsProtectedResourceMetadataDependencies {
  /**
   * Returns the lexical capability the host wants advertised, or `null`
   * to omit the entry. The operation does not modify the shape; the
   * host already accounts for `lexicalRetrievalSupported === false` and
   * `lexicalRetrievalCapability` overrides before calling.
   */
  resolveLexicalCapability(): RsProtectedResourceMetadataLexicalCapability | null;
  /**
   * Returns the semantic capability the host wants advertised, or
   * `null` to omit the entry. The host gates this on
   * `semanticRetrievalSupported`, the embedding backend's
   * `available()` flag, and any caller override.
   */
  resolveSemanticCapability():
    | RsProtectedResourceMetadataSemanticCapability
    | null
    | Promise<RsProtectedResourceMetadataSemanticCapability | null>;
  /**
   * Returns the hybrid capability the host has overridden, or `null`
   * to fall through to the operation's default composition rule
   * (publish iff lexical AND semantic are both `supported: true`).
   */
  resolveHybridCapabilityOverride(): RsProtectedResourceMetadataHybridCapability | null;
  /**
   * Build a hybrid capability advertisement from the live
   * `(lexicalAvailable, semanticAvailable)` flags. Hosts plug in the
   * `metadata.ts` builder; the operation reads back `supported` and
   * `cursor_supported` from the result.
   */
  buildDefaultHybridCapability(args: {
    lexicalAvailable: true;
    semanticAvailable: true;
  }): RsProtectedResourceMetadataHybridCapability | null;
  /**
   * Whether the host has suppressed hybrid advertisement entirely
   * (`hybridRetrievalSupported === false`). When `true`, the hybrid
   * capability is omitted regardless of the underlying lexical /
   * semantic state.
   */
  isHybridSuppressed(): boolean;
  /**
   * Whether the host is running in native single-source mode. When
   * `false`, the polyfill `owner_polyfill_requires_source_kind_connector`
   * discovery hint is published.
   */
  isNativeSingleSourceMode(): boolean;
  /**
   * Returns the client-event-subscriptions extension capability the host
   * wants advertised, or `null` to omit the entry. This is a
   * reference-implementation extension (`stability: "reference_extension"`),
   * not a Core PDPP capability; other implementations may expose a
   * different surface until a future Core change promotes one. The host
   * gates this on whether the routes are mounted and on any caller
   * override.
   *
   * Spec:
   *   openspec/changes/add-client-event-subscriptions/specs/
   *   reference-implementation-architecture/spec.md
   */
  resolveClientEventSubscriptionsCapability(): RsProtectedResourceMetadataClientEventSubscriptionsCapability | null;
}

export interface RsProtectedResourceMetadataInput {
  // Empty for now — composition is fully driven by dependencies. Kept
  // as a struct so future per-request signals (e.g., feature flags) can
  // be added without changing the call shape.
  [key: string]: never;
}

export interface RsProtectedResourceMetadataComposition {
  capabilities: RsProtectedResourceMetadataCapabilities;
  discoveryHints: RsProtectedResourceMetadataDiscoveryHints;
}

export interface RsProtectedResourceMetadataOutput {
  composition: RsProtectedResourceMetadataComposition;
}

function isLexicalSupported(
  cap: RsProtectedResourceMetadataLexicalCapability | null,
): boolean {
  return !!cap && cap.supported === true;
}

function isSemanticSupported(
  cap: RsProtectedResourceMetadataSemanticCapability | null,
): boolean {
  return !!cap && cap.supported === true;
}

/**
 * Execute the canonical `rs.protected-resource-metadata` operation.
 *
 * Returns the composed `(capabilities, discoveryHints)` pair. Hosts add
 * resource/issuer URLs, the agent-discovery block, version metadata,
 * and run the wire-shape builder.
 *
 * Async because `resolveSemanticCapability` may consult the active
 * storage backend to derive the honest `index_state`.
 */
export async function executeRsProtectedResourceMetadata(
  _input: RsProtectedResourceMetadataInput,
  dependencies: RsProtectedResourceMetadataDependencies,
): Promise<RsProtectedResourceMetadataOutput> {
  const capabilities: RsProtectedResourceMetadataCapabilities = {};

  const lexical = dependencies.resolveLexicalCapability();
  if (lexical) capabilities.lexical_retrieval = lexical;

  const semantic = await dependencies.resolveSemanticCapability();
  if (semantic) capabilities.semantic_retrieval = semantic;

  const lexicalSupported = isLexicalSupported(lexical);
  const semanticSupported = isSemanticSupported(semantic);

  if (!dependencies.isHybridSuppressed()) {
    const hybridOverride = dependencies.resolveHybridCapabilityOverride();
    if (hybridOverride) {
      capabilities.hybrid_retrieval = hybridOverride;
    } else if (lexicalSupported && semanticSupported) {
      const builtHybrid = dependencies.buildDefaultHybridCapability({
        lexicalAvailable: true,
        semanticAvailable: true,
      });
      if (builtHybrid && builtHybrid.supported === true) {
        capabilities.hybrid_retrieval = builtHybrid;
      }
    }
  }

  // Discovery hints. The fixed pointer block is always present; search
  // and hybrid pagination hints follow capability advertisement.
  const discoveryHints: {
    schema_endpoint: "/v1/schema";
    query_base: "/v1";
    connectors_endpoint: "/v1/connectors";
    streams_endpoint_template: "/v1/streams/{stream}";
    aggregate: { endpoint_template: "/v1/streams/{stream}/aggregate" };
    changes_since_bootstrap: "beginning";
    blob_indirection: "data.blob_ref.fetch_url";
    search?: {
      endpoint: string;
      scope_param: "streams[]";
      filter_requires_single_stream: true;
    };
    hybrid_pagination_supported?: boolean;
    owner_polyfill_requires_source_kind_connector?: true;
  } = {
    schema_endpoint: "/v1/schema",
    query_base: "/v1",
    connectors_endpoint: "/v1/connectors",
    streams_endpoint_template: "/v1/streams/{stream}",
    aggregate: { endpoint_template: "/v1/streams/{stream}/aggregate" },
    changes_since_bootstrap: "beginning",
    blob_indirection: "data.blob_ref.fetch_url",
  };

  if (lexicalSupported) {
    const endpoint =
      typeof (lexical as { endpoint?: unknown } | null)?.endpoint === "string"
        ? ((lexical as { endpoint: string }).endpoint)
        : "/v1/search";
    discoveryHints.search = {
      endpoint,
      scope_param: "streams[]",
      filter_requires_single_stream: true,
    };
  }

  if (capabilities.hybrid_retrieval?.supported === true) {
    discoveryHints.hybrid_pagination_supported =
      !!capabilities.hybrid_retrieval.cursor_supported;
  }

  if (!dependencies.isNativeSingleSourceMode()) {
    discoveryHints.owner_polyfill_requires_source_kind_connector = true;
  }

  const ces = dependencies.resolveClientEventSubscriptionsCapability();
  if (ces) capabilities.client_event_subscriptions = ces;

  return {
    composition: {
      capabilities,
      discoveryHints: discoveryHints as RsProtectedResourceMetadataDiscoveryHints,
    },
  };
}
