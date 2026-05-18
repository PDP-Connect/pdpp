/**
 * SQLite-backed driver for the lexical-retrieval conformance harness.
 *
 * Wraps the reference implementation's FTS5-backed `lexical_search_index`
 * table at the SQL level. Maintenance uses the existing canonical query
 * helpers (`searchIndexInsertRow`, `searchIndexDeleteByRecordKey`,
 * `searchIndexDeleteByStream`); search runs the same FTS5 MATCH +
 * `bm25()` + `snippet()` shape the production `runLexicalSearch` uses,
 * narrowed to one (connector_id, stream) and without the records table
 * join (the harness exercises lexical semantics independent of the
 * records lifecycle).
 *
 * This driver is the pinned baseline for the lexical conformance suite.
 * It is not exported from production code and SHALL NOT be treated as a
 * production `LexicalIndex` adapter — `/v1/search` continues to route
 * through `runLexicalSearch` directly.
 *
 * Spec: openspec/changes/add-lexical-retrieval-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import {
  exec,
  iterateDynamicSqlAcknowledged,
  referenceQueries,
} from '../../lib/db.ts';
import { closeDb, initDb } from '../../server/db.js';

function buildFtsUserTextQuery(q) {
  const terms = String(q || '')
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replaceAll('"', '""')}"`);
  return terms.length > 0 ? terms.join(' ') : '""';
}

export function createSqliteLexicalRetrievalDriver() {
  return {
    identity() {
      // Mirrors `buildLexicalRetrievalCapability()` defaults — declared here
      // so the conformance harness can read backend semantics from the same
      // surface the public RS metadata advertises.
      return {
        backend_kind: 'sqlite-fts5',
        tokenizer: 'unicode61',
        case_sensitive: false,
        supports_phrase_query: true,
        score: {
          kind: 'bm25',
          order: 'lower_is_better',
          value_semantics: 'implementation_relative',
        },
        supports_snippets: true,
      };
    },

    async setup() {
      initDb();
    },

    async teardown() {
      closeDb();
    },

    async upsert({ connectorId, stream, recordKey, fields }) {
      exec(referenceQueries.searchIndexDeleteByRecordKey, [
        connectorId,
        stream,
        recordKey,
      ]);
      for (const [field, value] of Object.entries(fields || {})) {
        if (typeof value !== 'string' || value.length === 0) continue;
        exec(referenceQueries.searchIndexInsertRow, [
          connectorId,
          stream,
          recordKey,
          field,
          value,
        ]);
      }
    },

    async deleteRecord({ connectorId, stream, recordKey }) {
      exec(referenceQueries.searchIndexDeleteByRecordKey, [
        connectorId,
        stream,
        recordKey,
      ]);
    },

    async deleteStream({ connectorId, stream }) {
      exec(referenceQueries.searchIndexDeleteByStream, [connectorId, stream]);
    },

    async search({ connectorId, stream, searchableFields, q }) {
      const ftsQuery = buildFtsUserTextQuery(q);
      // Per-(stream, field) match against the FTS5 table. Same shape as
      // production `runFtsQueryForConnector` minus the records join — the
      // harness focuses on lexical-index semantics, not the records
      // lifecycle. Per-record collapse and intra-(connector,stream) sort
      // by bm25 ascending, with record_key as a deterministic tiebreaker.
      const collapsed = new Map();
      for (const field of searchableFields) {
        // REVIEWED-DYNAMIC: harness query, fixed FTS5 shape, LIMIT included.
        const sql = `
          SELECT
            record_key                        AS record_key,
            snippet(lexical_search_index, 4, '', '', '…', 16) AS snippet_text,
            bm25(lexical_search_index)        AS score
          FROM lexical_search_index
          WHERE connector_id = ?
            AND stream       = ?
            AND field        = ?
            AND text MATCH   ?
          ORDER BY score ASC, record_key ASC
          LIMIT 200
        `;
        const rows = [];
        for (const row of iterateDynamicSqlAcknowledged(sql, [
          connectorId,
          stream,
          field,
          ftsQuery,
        ])) {
          rows.push(row);
        }
        for (const row of rows) {
          const existing = collapsed.get(row.record_key);
          if (existing) {
            if (!existing.matchedFields.includes(field)) {
              existing.matchedFields.push(field);
            }
            if (row.score < existing.score) {
              existing.score = Number(row.score);
              if (row.snippet_text) {
                existing.snippet = { field, text: row.snippet_text };
              }
            }
          } else {
            collapsed.set(row.record_key, {
              recordKey: row.record_key,
              matchedFields: [field],
              snippet: row.snippet_text
                ? { field, text: row.snippet_text }
                : null,
              score: Number(row.score),
            });
          }
        }
      }
      // Stable sort: bm25 ascending, then record_key ascending.
      return Array.from(collapsed.values()).sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return a.recordKey < b.recordKey ? -1 : a.recordKey > b.recordKey ? 1 : 0;
      });
    },
  };
}
