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

function makeKey(connectorId, stream, recordKey) {
  return `${connectorId} ${stream} ${recordKey}`;
}

export function createBrokenLexicalRetrievalDriver() {
  let rows;
  let flipNextTie;

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
      rows = new Map();
      flipNextTie = false;
    },

    async teardown() {
      rows = null;
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
      rows.set(makeKey(connectorId, stream, recordKey), {
        connectorId,
        stream,
        recordKey,
        fields: fieldMap,
      });
    },

    async deleteRecord({ connectorId, stream, recordKey }) {
      rows.delete(makeKey(connectorId, stream, recordKey));
    },

    async deleteStream({ connectorId, stream }) {
      for (const key of Array.from(rows.keys())) {
        if (key.startsWith(`${connectorId} ${stream} `)) {
          rows.delete(key);
        }
      }
    },

    async search({ connectorId, stream, searchableFields, q }) {
      const queryTokens = tokenize(q);
      if (queryTokens.length === 0) return [];

      const hits = [];
      for (const row of rows.values()) {
        if (row.connectorId !== connectorId || row.stream !== stream) continue;
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
          recordKey: row.recordKey,
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
