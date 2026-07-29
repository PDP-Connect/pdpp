// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hybrid Retrieval Experimental Extension — implementation helper.
 *
 * Realizes the public `hybrid-retrieval` capability defined in:
 *   openspec/changes/define-hybrid-retrieval/specs/hybrid-retrieval/spec.md
 *
 * Public-contract slice (allowlist, cursor rejection, forbidden-parameter
 * list, `q`-required, `limit` clamp, `streams[]` normalization,
 * `filter[...]` coupling, per-source fan-out under the caller's grant,
 * round-robin merge, dedup by `(connector_id, stream, record_key)`,
 * `retrieval_sources` provenance, per-source `scores` map,
 * `retrieval_mode: "hybrid"`, list-envelope shape, and the
 * `disclosure.served` data block) is owned by the canonical
 * `rs.search.hybrid` operation in `operations/rs-search-hybrid/index.ts`.
 * This module is the native dependency-wiring shell: it composes the
 * existing `runLexicalSearch` / `runSemanticSearch` runners under the same
 * grant and hands their per-source result envelopes to `executeSearchHybrid`.
 *
 * Design: hybrid is NOT a new grant-logic path — grant enforcement stays
 * inside the underlying `runLexicalSearch` / `runSemanticSearch` helpers.
 * The shell builds a synthetic sub-request that carries the parsed hybrid
 * params verbatim and lets each runner enforce advertisement, grant
 * projection, stream-grant intersection, field-grant intersection, and
 * record-level grant constraints.
 *
 * v1 pagination choice: NO cursor support. Snapshot-honest hybrid cursors
 * require encoding the combined-source snapshot identity; rather than ship
 * offset-only pagination over two independently changing candidate sets,
 * v1 rejects the `cursor` parameter (in the operation) and advertises
 * cursor_supported:false. Clients that need paging beyond `limit` should
 * fall back to the individual /v1/search and /v1/search/semantic endpoints
 * in this tranche.
 */

import type {
  SearchHybridActor,
  SearchHybridDependencies,
  SearchHybridErrorCode,
  SearchHybridSourceOutput,
  SearchHybridSourceResult,
  SearchHybridSubRequestParams,
} from "../operations/rs-search-hybrid/index.ts";
import {
  executeSearchHybrid,
  parseSearchHybridParams,
  SearchHybridRequestError,
} from "../operations/rs-search-hybrid/index.ts";
import { runLexicalSearch } from "./search.ts";
import { runSemanticSearch } from "./search-semantic.ts";

interface SearchRequest {
  query: Record<string, unknown>;
}
type HybridRequestQuery = Record<string, unknown> & {
  q: string;
  limit: string;
  "streams[]"?: string[];
  filter?: unknown;
  connection_id?: string;
  connector_instance_id?: string;
};
type NativeSearchArgs = Parameters<typeof runLexicalSearch>[0];
type SemanticSearchArgs = Parameters<typeof runSemanticSearch>[0];
type LexicalManifest = Parameters<NativeSearchArgs["buildOwnerReadGrantForManifest"]>[0];
type LexicalTokenInfo = NativeSearchArgs["tokenInfo"];
type SemanticManifest = Parameters<SemanticSearchArgs["buildOwnerReadGrantForManifest"]>[0];
type SemanticGrant = ReturnType<SemanticSearchArgs["buildOwnerReadGrantForManifest"]>;
type SemanticResolvedGrant = Awaited<ReturnType<SemanticSearchArgs["resolveGrantManifest"]>>;
type SemanticTokenInfo = SemanticSearchArgs["tokenInfo"];

function nativeSearchHybridError(error: SearchHybridRequestError, options: ErrorOptions): Error {
  const nativeError: Error & { code: SearchHybridErrorCode; param?: string } = Object.assign(
    new Error(error.message, options),
    { code: error.code }
  );
  if (error.param !== undefined) {
    nativeError.param = error.param;
  }
  return nativeError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isManifest(value: unknown): value is { streams: unknown[] } & Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.streams);
}

function isLexicalManifest(value: unknown): value is LexicalManifest {
  return isManifest(value);
}

function isSemanticGrant(value: unknown): value is SemanticGrant {
  return isRecord(value);
}

function isLexicalTokenInfo(value: unknown): value is LexicalTokenInfo {
  return isTokenInfo(value);
}

function isSemanticTokenInfo(value: unknown): value is SemanticTokenInfo {
  return isTokenInfo(value);
}

function isSemanticResolvedGrant(value: unknown): value is SemanticResolvedGrant {
  return isRecord(value) && isManifest(value.manifest);
}

function isSearchHybridSourceResult(value: unknown): value is SearchHybridSourceResult {
  if (
    !isRecord(value) ||
    typeof value.connector_id !== "string" ||
    (typeof value.emitted_at !== "string" && value.emitted_at !== null) ||
    !Array.isArray(value.matched_fields) ||
    !value.matched_fields.every((field) => typeof field === "string") ||
    typeof value.record_key !== "string" ||
    typeof value.record_url !== "string" ||
    typeof value.stream !== "string"
  ) {
    return false;
  }
  return true;
}

function normalizeSourceResult(value: unknown, label: string): SearchHybridSourceResult {
  if (!isSearchHybridSourceResult(value)) {
    throw new TypeError(`${label} must be a search-result object`);
  }
  return { ...value, object: "search_result" };
}

function isTokenInfo(value: unknown): value is { pdpp_token_kind: "client" | "owner" } & Record<string, unknown> {
  return isRecord(value) && (value.pdpp_token_kind === "client" || value.pdpp_token_kind === "owner");
}

function requireLexicalManifest(value: unknown): LexicalManifest {
  if (!isLexicalManifest(value)) {
    throw new TypeError("semantic search supplied an invalid manifest to the lexical grant builder");
  }
  return value;
}

function requireSemanticGrant(value: unknown): SemanticGrant {
  if (!isSemanticGrant(value)) {
    throw new TypeError("lexical grant builder returned an invalid semantic grant");
  }
  return value;
}

function requireLexicalTokenInfo(value: unknown): LexicalTokenInfo {
  if (!isLexicalTokenInfo(value)) {
    throw new TypeError("semantic search supplied invalid token information to the lexical grant resolver");
  }
  return value;
}

function requireSemanticTokenInfo(value: unknown): SemanticTokenInfo {
  if (!isSemanticTokenInfo(value)) {
    throw new TypeError("hybrid search received invalid token information");
  }
  return value;
}

function requireSemanticResolvedGrant(value: unknown): SemanticResolvedGrant {
  if (!isSemanticResolvedGrant(value)) {
    throw new TypeError("lexical grant resolver returned an invalid semantic grant resolution");
  }
  return value;
}

function semanticOptionsFrom(nativeOptions: NativeSearchArgs["opts"]): SemanticSearchArgs["opts"] {
  const options: SemanticSearchArgs["opts"] = {};
  if (!nativeOptions) {
    return options;
  }
  const capability = nativeOptions.semanticRetrievalCapability;
  if (capability === null || isRecord(capability)) {
    options.semanticRetrievalCapability = capability;
  }
  if (typeof nativeOptions.semanticRetrievalSupported === "boolean") {
    options.semanticRetrievalSupported = nativeOptions.semanticRetrievalSupported;
  }
  return options;
}

function normalizeLexicalSourceOutput(result: Awaited<ReturnType<typeof runLexicalSearch>>): SearchHybridSourceOutput {
  if (!Array.isArray(result.envelope.data)) {
    throw new TypeError("lexical search envelope data must be an array");
  }
  return {
    envelope: {
      data: result.envelope.data.map((item) => normalizeSourceResult(item, "lexical search envelope data")),
    },
  };
}

function normalizeSemanticSourceOutput(
  result: Awaited<ReturnType<typeof runSemanticSearch>>
): SearchHybridSourceOutput {
  if (!Array.isArray(result.envelope.data)) {
    throw new TypeError("semantic search envelope data must be an array");
  }
  return {
    envelope: {
      data: result.envelope.data.map((item) => normalizeSourceResult(item, "semantic search envelope data")),
    },
  };
}

/**
 * Parse and validate the v1 hybrid query-string allowlist.
 *
 * Thin delegating shim: the canonical implementation lives in
 * `operations/rs-search-hybrid/index.ts`. Kept exported here so any
 * existing direct callers continue to compile with the same plain-`Error`
 * shape (`Error` with `code` / optional `param`) the previous local
 * implementation produced.
 */
export function parseHybridSearchParams(query: Record<string, unknown>) {
  try {
    return parseSearchHybridParams(query);
  } catch (err) {
    if (err instanceof SearchHybridRequestError) {
      throw nativeSearchHybridError(err, { cause: err });
    }
    throw err;
  }
}

// The delegated sub-requests reuse the caller's parsed params verbatim.
// Building a small "sub-req" object is enough: both runners read only
// `req.query`. Any grant enforcement and advertisement checks happen inside
// the delegates — hybrid does NOT duplicate them.
function buildSubRequest(originalReq: SearchRequest, params: SearchHybridSubRequestParams): SearchRequest {
  const query: HybridRequestQuery = { limit: String(params.limit), q: params.q };
  if (params.streams && params.streams.length > 0) {
    query["streams[]"] = params.streams.slice();
  }
  if (params.filter && typeof params.filter === "object") {
    query.filter = params.filter;
  }
  // Forward `connection_id` / `connector_instance_id` narrowing to the
  // underlying lexical and semantic runners so cross-binding fan-in narrows
  // consistently with direct calls to `/v1/search` / `/v1/search/semantic`.
  const originalQuery = originalReq.query;
  if (typeof originalQuery.connection_id === "string" && originalQuery.connection_id.length > 0) {
    query.connection_id = originalQuery.connection_id;
  }
  if (typeof originalQuery.connector_instance_id === "string" && originalQuery.connector_instance_id.length > 0) {
    query.connector_instance_id = originalQuery.connector_instance_id;
  }
  return { ...originalReq, query };
}

function buildSemanticSearchArgs(args: NativeSearchArgs, params: SearchHybridSubRequestParams): SemanticSearchArgs {
  return {
    buildOwnerReadGrantForManifest(manifest: SemanticManifest): SemanticGrant {
      return requireSemanticGrant(args.buildOwnerReadGrantForManifest(requireLexicalManifest(manifest)));
    },
    getOwnerSubjectId: args.getOwnerSubjectId,
    opts: semanticOptionsFrom(args.opts),
    req: buildSubRequest(args.req, params),
    async resolveGrantManifest(tokenInfo: SemanticTokenInfo): Promise<SemanticResolvedGrant> {
      return requireSemanticResolvedGrant(await args.resolveGrantManifest(requireLexicalTokenInfo(tokenInfo)));
    },
    async resolveOwnerManifestFromScope(scope: Record<string, unknown>): Promise<SemanticResolvedGrant> {
      return requireSemanticResolvedGrant(await args.resolveOwnerManifestFromScope(scope));
    },
    resolveOwnerScopeForConnector: args.resolveOwnerScopeForConnector,
    async resolveOwnerVisibleConnectorIds(): Promise<string[]> {
      return await args.resolveOwnerVisibleConnectorIds();
    },
    tokenInfo: requireSemanticTokenInfo(args.tokenInfo),
  };
}

/**
 * The single helper the GET /v1/search/hybrid route delegates to.
 *
 * Composes runLexicalSearch + runSemanticSearch under the same grant by
 * calling each with a synthetic sub-request, then hands the per-source
 * envelopes to `executeSearchHybrid` which owns the merge / dedup /
 * envelope / disclosure shape.
 */
export async function runHybridSearch(args: NativeSearchArgs) {
  const {
    req,
    opts,
    tokenInfo,
    resolveOwnerVisibleConnectorIds,
    resolveOwnerScopeForConnector,
    resolveOwnerManifestFromScope,
    buildOwnerReadGrantForManifest,
    resolveGrantManifest,
    getOwnerSubjectId,
  } = args;
  const isOwner = tokenInfo.pdpp_token_kind === "owner";
  const actor: SearchHybridActor = isOwner
    ? { kind: "owner", subject_id: tokenInfo.subject_id ?? null }
    : {
        client_id: tokenInfo.client_id ?? null,
        grant_id: tokenInfo.grant_id ?? null,
        kind: "client",
        subject_id: tokenInfo.subject_id ?? null,
      };

  // Native dependencies wire the operation against the existing lexical /
  // semantic runners. Errors from either propagate unchanged — grant_stream_not_allowed
  // etc. behave identically to calling the underlying endpoints.
  const dependencies: SearchHybridDependencies = {
    runLexical: async (params) =>
      normalizeLexicalSourceOutput(
        await runLexicalSearch({
          buildOwnerReadGrantForManifest,
          getOwnerSubjectId,
          ...(opts === undefined ? {} : { opts }),
          req: buildSubRequest(req, params),
          resolveGrantManifest,
          resolveOwnerManifestFromScope,
          resolveOwnerScopeForConnector,
          resolveOwnerVisibleConnectorIds,
          tokenInfo,
        })
      ),
    runSemantic: async (params) =>
      normalizeSemanticSourceOutput(await runSemanticSearch(buildSemanticSearchArgs(args, params))),
  };

  let result: Awaited<ReturnType<typeof executeSearchHybrid>>;
  try {
    result = await executeSearchHybrid({ actor, query: req.query }, dependencies);
  } catch (err) {
    if (err instanceof SearchHybridRequestError) {
      // Translate operation-typed errors into the plain-object error shape
      // the existing native error path expects (`err.code`, optional
      // `err.param`). Preserves the previous public error envelope.
      throw nativeSearchHybridError(err, { cause: err });
    }
    throw err;
  }

  return {
    disclosureData: result.disclosureData,
    envelope: {
      data: result.envelope.data,
      has_more: result.envelope.has_more,
      object: "list",
      url: "/v1/search/hybrid",
      // Carry the operation's canonical `meta.warnings[]` (limit_clamped,
      // deprecated_alias_used, source_skipped_not_applicable) through to the
      // REST response. Omitted when the operation produced no warnings.
      ...(result.envelope.meta ? { meta: result.envelope.meta } : {}),
    },
  };
}
