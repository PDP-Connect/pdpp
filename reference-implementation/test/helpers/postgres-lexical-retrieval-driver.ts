// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { LexicalIdentity } from "./lexical-retrieval-conformance.ts";

/**
 * Postgres lexical-retrieval conformance driver.
 *
 * The mirror of `sqlite-lexical-retrieval-driver.js`, but every operation calls
 * the REAL production Postgres lexical functions (`postgresLexicalIndexUpsert`,
 * `postgresLexicalIndexDelete`, `postgresLexicalIndexDeleteByConnectorStream`,
 * `postgresLexicalSearch`) so the shared `runLexicalRetrievalConformance` suite
 * exercises production code, not a test reimplementation. This closes the gap
 * where the lexical-retrieval conformance contract was pinned only against
 * SQLite/memory, leaving the Postgres lexical path unverified against the same
 * behavioral assertions (the search-path analogue of the records meta.window
 * parity gap caught earlier).
 *
 * Requires `PDPP_TEST_POSTGRES_URL`. The pairing test file registers a single
 * skipped placeholder when that env var is unset.
 */

import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../../server/owner-auth.ts";
import {
  postgresLexicalIndexDelete,
  postgresLexicalIndexDeleteByConnectorStream,
  postgresLexicalIndexUpsert,
  postgresLexicalSearch,
} from "../../server/postgres-search.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../../server/postgres-storage.ts";
import { makeDefaultAccountConnectorInstanceId } from "../../server/stores/connector-instance-store.ts";

interface LexicalFields {
  [key: string]: string;
}
interface LexicalHit {
  matchedFields: string[];
  recordKey: string;
  score: number;
  snippet: { field: string; text: string } | null;
}

// The production Postgres lexical search JOINs lexical_search_index against the
// records table (a hit must correspond to a visible, non-deleted record), so
// the driver keeps a matching records row for every indexed record. Use the
// same default connector_instance_id the production index functions resolve.
function cii(connectorId: string): string {
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

export function createPostgresLexicalRetrievalDriver({ databaseUrl }: { databaseUrl: string }) {
  return {
    async deleteRecord({ connectorId, stream, recordKey }: { connectorId: string; stream: string; recordKey: string }) {
      await postgresLexicalIndexDelete({ connectorId, recordKey, stream });
      await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3", [
        cii(connectorId),
        stream,
        recordKey,
      ]);
    },

    async deleteStream({ connectorId, stream }: { connectorId: string; stream: string }) {
      await postgresLexicalIndexDeleteByConnectorStream({ connectorId, stream });
      await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1 AND stream = $2", [
        cii(connectorId),
        stream,
      ]);
    },
    identity(): LexicalIdentity {
      // Mirrors the production Postgres lexical capability: a tsvector index
      // ranked by ts_rank_cd, where a HIGHER score is a better match (the
      // opposite direction from SQLite BM25). The conformance suite reads this
      // ordering, so the direction difference is declared, not assumed.
      return {
        backend_kind: "postgres-tsvector",
        case_sensitive: false,
        score: {
          kind: "ts_rank_cd",
          order: "higher_is_better",
          value_semantics: "implementation_relative",
        },
        // Production uses plainto_tsquery, which ANDs the query terms with no
        // phrase ordering, so the Postgres lexical path does not support phrase
        // queries. Declared honestly rather than overclaimed.
        supports_phrase_query: false,
        supports_snippets: true,
        tokenizer: "simple",
      };
    },

    async search({
      connectorId,
      stream,
      searchableFields,
      q,
    }: {
      connectorId: string;
      stream: string;
      searchableFields: string[];
      q: string;
    }): Promise<LexicalHit[]> {
      const rows = await postgresLexicalSearch({ connectorId, limit: 200, q, searchableFields, stream });
      // Collapse per-(record_key) to the hit shape the conformance suite reads:
      // { recordKey, score, snippet?: { field, text }, matchedFields }. The
      // production function returns one row per matching (record, field); the
      // best (highest ts_rank_cd) field per record wins the snippet/score.
      const collapsed = new Map<string, LexicalHit>();
      for (const row of rows) {
        const score = Number(row.score);
        const existing = collapsed.get(row.record_key);
        if (existing) {
          existing.matchedFields.push(row.field);
          if (score > existing.score) {
            existing.score = score;
            if (row.snippet_text) {
              existing.snippet = { field: row.field, text: row.snippet_text };
            }
          }
        } else {
          collapsed.set(row.record_key, {
            matchedFields: [row.field],
            recordKey: row.record_key,
            score,
            snippet: row.snippet_text ? { field: row.field, text: row.snippet_text } : null,
          });
        }
      }
      // Preserve the production query's own ordering (it returns rows
      // `ORDER BY score DESC, record_key ASC`). Map insertion order reflects
      // the SQL row order, so we do NOT re-sort here. Re-sorting would make
      // the ordering conformance scenario test the driver's sort rather than
      // the production query's ORDER BY contract. A broken production ORDER BY
      // must surface as a conformance failure.
      return [...collapsed.values()];
    },

    async setup() {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      // Start from a clean index AND records table so scenarios do not leak
      // across runs sharing one test database.
      await postgresQuery("DELETE FROM lexical_search_index WHERE true").catch(() => {
        /* intentionally empty */
      });
      await postgresQuery("DELETE FROM records WHERE true").catch(() => {
        /* intentionally empty */
      });
    },

    async teardown() {
      await postgresQuery("DELETE FROM lexical_search_index WHERE true").catch(() => {
        /* intentionally empty */
      });
      await postgresQuery("DELETE FROM records WHERE true").catch(() => {
        /* intentionally empty */
      });
      await closePostgresStorage();
    },

    async upsert({
      connectorId,
      stream,
      recordKey,
      fields,
    }: {
      connectorId: string;
      stream: string;
      recordKey: string;
      fields: LexicalFields;
    }) {
      await postgresLexicalIndexUpsert({ connectorId, fields, recordKey, stream });
      // Maintain the matching visible records row the production search JOINs to.
      const connectorInstanceId = cii(connectorId);
      await postgresQuery(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, 1, FALSE, $4)
         ON CONFLICT (connector_instance_id, stream, record_key) DO UPDATE
           SET record_json = EXCLUDED.record_json, deleted = FALSE`,
        [
          connectorId,
          connectorInstanceId,
          stream,
          recordKey,
          JSON.stringify({ id: recordKey, ...fields }),
          "2026-06-01T00:00:00.000Z",
        ]
      );
    },
  };
}
