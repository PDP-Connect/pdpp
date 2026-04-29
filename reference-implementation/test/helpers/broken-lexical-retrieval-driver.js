/**
 * Broken / falsifiability driver for the lexical-retrieval conformance
 * harness.
 *
 * Deliberately non-conformant in two specific ways:
 *
 *   1. Drop-on-upsert: silently discards every other index row by skipping
 *      the second declared field. A query that should hit on the dropped
 *      field returns zero results, falsifying the upsert/query scenario.
 *   2. Non-deterministic tie ordering: for results with the same score,
 *      the driver uses `Array.prototype.reverse()` after a stable sort to
 *      flip the order on every call, falsifying the deterministic-tie
 *      scenario.
 *
 * If the harness is sound, at least one scenario MUST fail when exercised
 * against this driver. If every scenario passed, the harness would be a
 * green-path wrapper rather than a real conformance gate.
 *
 * Test-only. Not exported from production code and SHALL NOT be used as a
 * production adapter.
 *
 * Spec: openspec/changes/add-lexical-retrieval-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((tok) => tok.length > 0);
}

export function createBrokenLexicalRetrievalDriver() {
  // Nested map: connectorId -> stream -> recordKey -> { fields }. Same
  // collision-safe shape as the conforming memory driver — the broken
  // driver's failures are in upsert field-dropping and tie-order
  // flipping, not key encoding.
  let byConnector;
  let flipNextTie;

  function getStreamMap(connectorId, stream, { create } = { create: false }) {
    let streams = byConnector.get(connectorId);
    if (!streams) {
      if (!create) return null;
      streams = new Map();
      byConnector.set(connectorId, streams);
    }
    let recs = streams.get(stream);
    if (!recs) {
      if (!create) return null;
      recs = new Map();
      streams.set(stream, recs);
    }
    return recs;
  }

  return {
    identity() {
      return {
        backend_kind: 'broken-test-only',
        tokenizer: 'token-frequency',
        case_sensitive: false,
        supports_phrase_query: false,
        score: {
          kind: 'token_frequency',
          order: 'higher_is_better',
          value_semantics: 'implementation_relative',
        },
        supports_snippets: true,
      };
    },

    async setup() {
      byConnector = new Map();
      flipNextTie = false;
    },

    async teardown() {
      byConnector = null;
    },

    async upsert({ connectorId, stream, recordKey, fields }) {
      const fieldMap = new Map();
      // Deliberately drop every field after the first: a record indexed
      // on { title, body } loses the body content. Queries that hit on
      // the dropped field will return zero results, falsifying the
      // upsert/query scenario.
      let kept = 0;
      for (const [field, value] of Object.entries(fields || {})) {
        if (typeof value !== 'string' || value.length === 0) continue;
        if (kept >= 1) continue;
        fieldMap.set(field, value);
        kept += 1;
      }
      const recs = getStreamMap(connectorId, stream, { create: true });
      recs.set(recordKey, { fields: fieldMap });
    },

    async deleteRecord({ connectorId, stream, recordKey }) {
      const recs = getStreamMap(connectorId, stream);
      if (recs) recs.delete(recordKey);
    },

    async deleteStream({ connectorId, stream }) {
      const streams = byConnector.get(connectorId);
      if (streams) streams.delete(stream);
    },

    async search({ connectorId, stream, searchableFields, q }) {
      const queryTokens = tokenize(q);
      if (queryTokens.length === 0) return [];

      const recs = getStreamMap(connectorId, stream);
      if (!recs) return [];

      const hits = [];
      for (const [recordKey, row] of recs) {
        const matchedFields = [];
        let totalScore = 0;
        let bestField = null;
        for (const field of searchableFields) {
          const text = row.fields.get(field);
          if (!text) continue;
          const docTokens = tokenize(text);
          let fieldScore = 0;
          for (const qt of queryTokens) {
            for (const dt of docTokens) {
              if (dt === qt) fieldScore += 1;
            }
          }
          if (fieldScore > 0) {
            matchedFields.push(field);
            totalScore += fieldScore;
            if (!bestField) bestField = field;
          }
        }
        if (matchedFields.length === 0) continue;
        const snippet = bestField
          ? { field: bestField, text: row.fields.get(bestField) || '' }
          : null;
        hits.push({
          recordKey,
          matchedFields,
          snippet,
          score: totalScore,
        });
      }

      hits.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.recordKey < b.recordKey ? -1 : a.recordKey > b.recordKey ? 1 : 0;
      });

      // Deliberately non-deterministic tie ordering: every other call
      // flips the ordering so two consecutive identical queries return
      // different sequences. The harness's deterministic-tie scenario
      // catches this.
      flipNextTie = !flipNextTie;
      if (flipNextTie) {
        hits.reverse();
      }
      return hits;
    },
  };
}
