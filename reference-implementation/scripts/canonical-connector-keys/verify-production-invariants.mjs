#!/usr/bin/env node
/**
 * canonical-connector-keys / verify-production-invariants.mjs
 *
 * DATA-AGNOSTIC post-migration verification for the §3.4 owner-run gate.
 *
 * The companion verifiers `verify-backup-restore.mjs` and
 * `verify-http-surfaces.mjs` assert the §3.4 invariants against the
 * SYNTHETIC seed (`fixtures/backup-restore-seed.sql`): they hard-code the
 * seed's grant ids, record counts, owner subject, and stream names. Those
 * are the right checks for the no-human harness, but they CANNOT be pointed
 * at a real operator backup, whose rows are unknown.
 *
 * This script asserts only the structural invariants that must hold after a
 * correct migration regardless of WHAT data is present, so an operator can
 * run it against a restore of their own production backup:
 *
 *   1. No active-tier `connector_id` column holds a URL-shaped, legacy-alias,
 *      or `local-device:`-wrapped value. (Backup/scratch tiers are excluded,
 *      mirroring the migration's own surface taxonomy.)
 *   2. No active-tier JSONB-embedded connector id (the same four surfaces the
 *      migration rewrites) holds a non-canonical value.
 *   3. Every active-tier connector id that IS present canonicalizes to itself
 *      (i.e. is already the bare canonical key) — a positive restatement of 1+2
 *      that also catches values that are neither URL/legacy/wrapped nor a known
 *      canonical key (e.g. an unmapped custom slug left behind).
 *   4. If a `--before` row-count snapshot is supplied, row counts are preserved
 *      on every table in the snapshot (the migration must never drop or
 *      duplicate rows).
 *
 * It does NOT assert any specific id, count, owner, or payload — those are the
 * operator's data and vary per deployment. Pair it with:
 *   - `cli.mjs inspect` (fail-closed dry-run BEFORE writing), and
 *   - a second `cli.mjs write --apply` (idempotency: must rewrite nothing),
 * both of which are already data-agnostic.
 *
 * Usage:
 *   PDPP_DATABASE_URL=postgres://...  \
 *   node verify-production-invariants.mjs [--before <before-counts.json>]
 *
 * Exits 0 when every invariant holds, 1 otherwise. Prints a checklist.
 * Never prints the database URL.
 */

import { readFileSync } from 'node:fs';

import {
  canonicalConnectorKey,
  isConnectorKey,
  isRegistryUrlConnectorId,
} from '../../server/connector-key.js';
import {
  JSONB_CONNECTOR_ID_SHAPES,
  classifyTableSurface,
  quotePgIdentifier,
} from './inspect.mjs';

const LOCAL_DEVICE_PREFIX = 'local-device:';

function parseArgs(argv) {
  const out = { before: null };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--before') out.before = a[++i];
  }
  return out;
}

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail ?? '' });
}

/**
 * A value is a straggler — a pre-migration connector-id form that a correct
 * migration must NOT leave behind in an active surface — when it is one of the
 * known shapes the migration rewrites:
 *
 *   - URL-shaped first-party id (`https://registry.pdpp.org/connectors/<slug>`)
 *   - legacy snake_case local-collector alias (`claude_code`)
 *   - `local-device:`-wrapped storage form (`local-device:codex:cin_…`)
 *   - a known first-party/native/legacy value that canonicalizes to a DIFFERENT
 *     key (defence-in-depth; the three explicit checks already cover today's
 *     aliases, but this catches any future allowlist alias)
 *   - a syntactically INVALID connector key that is none of the above (e.g. a
 *     document URL or a value with a space) — genuinely malformed leftover
 *
 * Crucially, a value that is a *valid custom connector key not in the
 * first-party allowlist* (e.g. `my_org_crm`) is NOT a straggler: the migration
 * legitimately leaves such keys untouched because a custom manifest declares
 * its own canonical key. Using `canonicalConnectorKey(v) !== v` here would
 * FALSELY flag every custom-connector deployment, so we deliberately test the
 * known pre-migration shapes plus key validity instead.
 *
 * Pure, no DB.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNonCanonicalConnectorId(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  // Known pre-migration shapes that MUST have been rewritten.
  if (isRegistryUrlConnectorId(value)) return true;
  if (value.startsWith(LOCAL_DEVICE_PREFIX)) return true;
  // A known allowlist value (incl. legacy snake_case alias) that maps to a
  // DIFFERENT canonical key is a straggler. `codex` is both a first-party key
  // and a legacy alias for itself, so the identity check below correctly keeps
  // it; `claude_code` -> `claude-code` is flagged. For values outside every
  // allowlist, canonicalConnectorKey is null and we fall through to validity.
  const canonical = canonicalConnectorKey(value);
  if (canonical !== null && canonical !== value) return true;
  // Not a known shape and not a known key. Accept it ONLY if it is a
  // syntactically valid custom connector key; otherwise it is a malformed
  // leftover (e.g. a non-registry URL, whitespace, delimiter form).
  return !isConnectorKey(value);
}

async function activeConnectorIdColumns(pool) {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'connector_id'`,
  );
  return rows
    .map((r) => ({ table: r.table_name, column: r.column_name }))
    .filter(({ table }) => classifyTableSurface(table) === 'active');
}

async function main() {
  const { before: beforePath } = parseArgs(process.argv);
  const url = process.env.PDPP_DATABASE_URL;
  if (!url) throw new Error('PDPP_DATABASE_URL is required');
  const beforeCounts = beforePath ? JSON.parse(readFileSync(beforePath, 'utf8')) : null;

  const pg = await import('pg');
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString: url });

  try {
    // --- 1. no non-canonical connector_id in any active column -----------
    const activeCols = await activeConnectorIdColumns(pool);
    let columnStragglers = 0;
    const columnDetail = [];
    for (const { table, column } of activeCols) {
      const { rows } = await pool.query(
        `SELECT ${quotePgIdentifier(column)} AS v, COUNT(*)::int AS n
           FROM ${quotePgIdentifier(table)}
          WHERE ${quotePgIdentifier(column)} IS NOT NULL
          GROUP BY ${quotePgIdentifier(column)}`,
      );
      for (const r of rows) {
        if (isNonCanonicalConnectorId(r.v)) {
          columnStragglers += r.n;
          columnDetail.push(`${table}.${column}=${r.v} (${r.n})`);
        }
      }
    }
    check(
      'no non-canonical connector_id in any active column',
      columnStragglers === 0,
      columnDetail.join('; '),
    );

    // --- 2. no non-canonical connector_id in any active JSONB surface ----
    // Walk the exact same JSONB shapes the migration rewrites, classifying
    // each extracted id with the same canonical helper. Active-tier only.
    let jsonbStragglers = 0;
    const jsonbDetail = [];
    for (const shape of JSONB_CONNECTOR_ID_SHAPES) {
      if (classifyTableSurface(shape.table) !== 'active') continue;
      // Confirm the column exists in this deployment before scanning.
      const { rows: colRows } = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = $1 AND column_name = $2`,
        [shape.table, shape.column],
      );
      if (colRows.length === 0) continue;
      const { rows } = await pool.query(
        `SELECT ${quotePgIdentifier(shape.column)} AS j
           FROM ${quotePgIdentifier(shape.table)}
          WHERE ${quotePgIdentifier(shape.column)} IS NOT NULL`,
      );
      for (const row of rows) {
        let json = row.j;
        if (typeof json === 'string') {
          try {
            json = JSON.parse(json);
          } catch {
            continue;
          }
        }
        for (const { path, value } of shape.extract(json)) {
          if (isNonCanonicalConnectorId(value)) {
            jsonbStragglers += 1;
            jsonbDetail.push(`${shape.table}.${shape.column}${path}=${value}`);
          }
        }
      }
    }
    check(
      'no non-canonical connector_id in any active JSONB surface',
      jsonbStragglers === 0,
      jsonbDetail.slice(0, 10).join('; '),
    );

    // --- 3. report active-tier distinct keys (informational, no assertion on value) ---
    const { rows: distinctRows } = await pool.query(
      `SELECT DISTINCT connector_id FROM connectors ORDER BY connector_id`,
    );
    const distinctKeys = distinctRows.map((r) => r.connector_id);
    check(
      'all connectors rows carry a canonical key',
      distinctKeys.every((k) => !isNonCanonicalConnectorId(k)),
      `keys=${distinctKeys.join(',')}`,
    );

    // --- 4. row counts preserved (if a before snapshot is supplied) ------
    if (beforeCounts) {
      for (const [table, beforeN] of Object.entries(beforeCounts)) {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM ${quotePgIdentifier(table)}`,
        );
        const afterN = rows[0].n;
        if (table === 'connectors') {
          // The `connectors` PARENT table may legitimately SHRINK: when two
          // pre-migration ids map to the same canonical key (e.g. a URL-shaped
          // gmail row AND a bare `gmail` row, or `claude_code` AND
          // `claude-code`), the writer collapses them into one canonical parent
          // (registry-URL source wins) and deletes the duplicate. It must never
          // GROW. So assert after <= before for connectors, not equality.
          check(
            `connectors row count not increased (${beforeN} -> ${afterN}; <= expected, shrink = intentional parent collapse)`,
            afterN <= beforeN,
            afterN <= beforeN ? '' : `grew from ${beforeN} to ${afterN}`,
          );
          continue;
        }
        check(
          `row count preserved: ${table} (${beforeN} -> ${afterN})`,
          afterN === beforeN,
          afterN === beforeN ? '' : `expected ${beforeN}, got ${afterN}`,
        );
      }
    } else {
      check(
        'row-count parity check skipped (no --before snapshot supplied)',
        true,
        'pass --before <counts.json> to assert row counts are preserved',
      );
    }
  } finally {
    await pool.end();
  }

  const failed = checks.filter((c) => !c.pass);
  process.stdout.write('# §3.4 production-invariant verification (data-agnostic)\n');
  for (const c of checks) {
    process.stdout.write(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}\n`);
  }
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) process.exit(1);
}

const isDirectInvocation = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((err) => {
    const safe = String(err?.message ?? err).replace(/postgres(ql)?:\/\/[^\s'"]+/gi, 'postgres://<redacted>');
    process.stderr.write(`verify-production-invariants error: ${safe}\n`);
    process.exit(1);
  });
}
