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

import {
  executeSearchHybrid,
  parseSearchHybridParams,
  SearchHybridRequestError,
} from '../operations/rs-search-hybrid/index.ts';
import { runLexicalSearch } from './search.js';
import { runSemanticSearch } from './search-semantic.js';

/**
 * Parse and validate the v1 hybrid query-string allowlist.
 *
 * Thin delegating shim: the canonical implementation lives in
 * `operations/rs-search-hybrid/index.ts`. Kept exported here so any
 * existing direct callers continue to compile with the same plain-`Error`
 * shape (`Error` with `code` / optional `param`) the previous local
 * implementation produced.
 */
export function parseHybridSearchParams(query) {
  try {
    return parseSearchHybridParams(query);
  } catch (err) {
    if (err instanceof SearchHybridRequestError) {
      const translated = new Error(err.message);
      translated.code = err.code;
      if (err.param !== undefined) translated.param = err.param;
      throw translated;
    }
    throw err;
  }
}

// The delegated sub-requests reuse the caller's parsed params verbatim.
// Building a small "sub-req" object is enough: both runners read only
// `req.query`. Any grant enforcement and advertisement checks happen inside
// the delegates — hybrid does NOT duplicate them.
function buildSubRequest(originalReq, params) {
  const query = { q: params.q, limit: String(params.limit) };
  if (params.streams && params.streams.length > 0) {
    query['streams[]'] = params.streams.slice();
  }
  if (params.filter && typeof params.filter === 'object') {
    query.filter = params.filter;
  }
  // Forward `connection_id` / `connector_instance_id` narrowing to the
  // underlying lexical and semantic runners so cross-binding fan-in narrows
  // consistently with direct calls to `/v1/search` / `/v1/search/semantic`.
  const originalQuery = originalReq?.query || {};
  if (typeof originalQuery.connection_id === 'string'
      && originalQuery.connection_id.length > 0) {
    query.connection_id = originalQuery.connection_id;
  }
  if (typeof originalQuery.connector_instance_id === 'string'
      && originalQuery.connector_instance_id.length > 0) {
    query.connector_instance_id = originalQuery.connector_instance_id;
  }
  return { ...originalReq, query };
}

/**
 * The single helper the GET /v1/search/hybrid route delegates to.
 *
 * Composes runLexicalSearch + runSemanticSearch under the same grant by
 * calling each with a synthetic sub-request, then hands the per-source
 * envelopes to `executeSearchHybrid` which owns the merge / dedup /
 * envelope / disclosure shape.
 */
export async function runHybridSearch({
  req,
  opts,
  tokenInfo,
  resolveOwnerVisibleConnectorIds,
  resolveOwnerScopeForConnector,
  resolveOwnerManifestFromScope,
  buildOwnerReadGrantForManifest,
  resolveGrantManifest,
  getOwnerSubjectId,
}) {
  const isOwner = tokenInfo.pdpp_token_kind === 'owner';
  const actor = isOwner
    ? { kind: 'owner', subject_id: tokenInfo.subject_id ?? null }
    : {
        kind: 'client',
        subject_id: tokenInfo.subject_id ?? null,
        client_id: tokenInfo.client_id ?? null,
        grant_id: tokenInfo.grant_id ?? null,
      };

  // Native dependencies wire the operation against the existing lexical /
  // semantic runners. Errors from either propagate unchanged — grant_stream_not_allowed
  // etc. behave identically to calling the underlying endpoints.
  const dependencies = {
    runLexical: (params) =>
      runLexicalSearch({
        req: buildSubRequest(req, params),
        opts,
        tokenInfo,
        resolveOwnerVisibleConnectorIds,
        resolveOwnerScopeForConnector,
        resolveOwnerManifestFromScope,
        buildOwnerReadGrantForManifest,
        resolveGrantManifest,
        getOwnerSubjectId,
      }),
    runSemantic: (params) =>
      runSemanticSearch({
        req: buildSubRequest(req, params),
        opts,
        tokenInfo,
        resolveOwnerVisibleConnectorIds,
        resolveOwnerScopeForConnector,
        resolveOwnerManifestFromScope,
        buildOwnerReadGrantForManifest,
        resolveGrantManifest,
        getOwnerSubjectId,
      }),
  };

  let result;
  try {
    result = await executeSearchHybrid(
      { actor, query: req.query },
      dependencies,
    );
  } catch (err) {
    if (err instanceof SearchHybridRequestError) {
      // Translate operation-typed errors into the plain-object error shape
      // the existing native error path expects (`err.code`, optional
      // `err.param`). Preserves the previous public error envelope.
      const translated = new Error(err.message);
      translated.code = err.code;
      if (err.param !== undefined) translated.param = err.param;
      throw translated;
    }
    throw err;
  }

  return {
    envelope: {
      object: 'list',
      url: '/v1/search/hybrid',
      has_more: result.envelope.has_more,
      data: result.envelope.data,
    },
    disclosureData: result.disclosureData,
  };
}
