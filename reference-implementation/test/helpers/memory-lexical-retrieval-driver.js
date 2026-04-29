/**
 * In-memory driver for the lexical-retrieval conformance harness.
 *
 * This driver is deliberately not FTS5. It declares its honest backend
 * identity (`memory-token-frequency`, `tokenizer: 'token-frequency'`,
 * `score.kind: 'token_frequency'`, `score.order: 'higher_is_better'`) and
 * implements ranking as a simple per-record token-occurrence count over
 * the union of the supplied searchable fields.
 *
 * The point of the memory driver is to prove the conformance harness
 * encodes portable obligations (upsert/delete/delete-by-stream
 * semantics, deterministic ordering, snippet honesty, no-result
 * behavior) rather than FTS5-specific scoring. Drivers that advertise
 * different backend semantics MUST still pass the harness.
 *
 * Test-only. Not exported from production code.
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

export function createMemoryLexicalRetrievalDriver() {
  // Nested map: connectorId -> stream -> recordKey -> row. Avoids any
  // string-delimiter assumption about connector ids, stream names, or
  // record keys; the harness must work for arbitrary protocol-legal
  // inputs, including ones that contain ordinary printable characters
  // a delimiter would otherwise collide with.
  //   byConnector: Map<connectorId,
  //     Map<stream,
  //       Map<recordKey, { fields: Map<field, text> }>>>
  let byConnector;

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
        backend_kind: 'memory-token-frequency',
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
    },

    async teardown() {
      byConnector = null;
    },

    async upsert({ connectorId, stream, recordKey, fields }) {
      const recs = getStreamMap(connectorId, stream, { create: true });
      const fieldMap = new Map();
      for (const [field, value] of Object.entries(fields || {})) {
        if (typeof value !== 'string' || value.length === 0) continue;
        fieldMap.set(field, value);
      }
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
        let bestFieldScore = -1;

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
            if (fieldScore > bestFieldScore) {
              bestFieldScore = fieldScore;
              bestField = field;
            }
          }
        }

        if (matchedFields.length === 0) continue;

        let snippet = null;
        if (bestField) {
          const text = row.fields.get(bestField) || '';
          // Honest extraction: locate the first matching token in the
          // source text and return a small substring around it. The
          // snippet is always a verbatim slice of the source field,
          // never generated content.
          const lower = text.toLowerCase();
          let snippetStart = 0;
          for (const qt of queryTokens) {
            const idx = lower.indexOf(qt);
            if (idx >= 0) {
              snippetStart = Math.max(0, idx - 8);
              break;
            }
          }
          const snippetText = text.slice(
            snippetStart,
            Math.min(text.length, snippetStart + 64),
          );
          snippet = { field: bestField, text: snippetText };
        }

        hits.push({
          recordKey,
          matchedFields,
          snippet,
          score: totalScore,
        });
      }

      // Honest deterministic order: token_frequency descending (better
      // first), then record_key ascending as a stable tiebreaker.
      hits.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.recordKey < b.recordKey ? -1 : a.recordKey > b.recordKey ? 1 : 0;
      });
      return hits;
    },
  };
}
