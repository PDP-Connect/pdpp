#!/usr/bin/env node
/**
 * canonical-connector-keys / verify-backup-restore.mjs
 *
 * Post-migration assertions for the §3.4 backup/restore validation
 * harness (run-backup-restore-validation.sh). Connects to the restored,
 * migrated DISPOSABLE database and proves the four things task 3.4 names:
 *
 *   1. row counts preserved (per table, before vs after migration);
 *   2. canonical connector ids — every active connector_id column and
 *      every JSONB-embedded id is now the bare canonical key; no
 *      URL-shaped / legacy-alias / local-device-wrapped value remains
 *      in any active-tier table;
 *   3. grants + grant-package membership preserved (same grant_ids,
 *      same package membership, canonical ids inside the JSONB);
 *   4. record hydration — the seeded records are still present and
 *      readable under the canonical key, joined to their instances.
 *
 * Also proves the negative control: the backup_* tier table keeps its
 * URL-shaped connector_id (migration must not rewrite backup tables by
 * default).
 *
 * Usage:
 *   PDPP_DATABASE_URL=postgres://... \
 *   node verify-backup-restore.mjs --before <before-counts.json>
 *
 * Exits 0 when every assertion holds, 1 otherwise. Prints a checklist.
 */

import { readFileSync } from 'node:fs';

const URL_GMAIL = 'https://registry.pdpp.org/connectors/gmail';

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

async function main() {
  const { before: beforePath } = parseArgs(process.argv);
  const url = process.env.PDPP_DATABASE_URL;
  if (!url) throw new Error('PDPP_DATABASE_URL is required');
  const beforeCounts = beforePath ? JSON.parse(readFileSync(beforePath, 'utf8')) : null;

  const pg = await import('pg');
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString: url });

  try {
    // --- 1. row counts preserved -------------------------------------
    if (beforeCounts) {
      for (const [table, beforeN] of Object.entries(beforeCounts)) {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${quote(table)}`);
        const afterN = rows[0].n;
        // connectors may intentionally collapse (URL gmail -> gmail,
        // claude_code -> claude-code are NEW parents; old parents
        // deleted). Net count is preserved here because each old id maps
        // to a distinct canonical key (no many-to-one collapse in seed).
        check(
          `row count preserved: ${table} (${beforeN} -> ${afterN})`,
          afterN === beforeN,
          afterN === beforeN ? '' : `expected ${beforeN}, got ${afterN}`,
        );
      }
    }

    // --- 2. canonical connector ids, no stragglers -------------------
    // 2a. canonical parents now exist.
    for (const key of ['gmail', 'claude-code', 'codex', 'spotify']) {
      const { rows } = await pool.query(
        `SELECT 1 FROM connectors WHERE connector_id = $1`, [key]);
      check(`connectors has canonical key '${key}'`, rows.length === 1);
    }
    // 2b. old URL/legacy parents gone.
    for (const old of [URL_GMAIL, 'claude_code']) {
      const { rows } = await pool.query(
        `SELECT 1 FROM connectors WHERE connector_id = $1`, [old]);
      check(`connectors no longer has stale id '${old}'`, rows.length === 0);
    }
    // 2c. NO active-tier connector_id column holds a URL/legacy/wrapped form.
    const activeCols = await activeConnectorIdColumns(pool);
    let strayTotal = 0;
    const strayDetails = [];
    for (const { table, column } of activeCols) {
      const { rows } = await pool.query(
        `SELECT ${quote(column)} AS v, COUNT(*)::int AS n FROM ${quote(table)}
          WHERE ${quote(column)} LIKE 'https://%'
             OR ${quote(column)} LIKE 'local-device:%'
             OR ${quote(column)} = 'claude_code'
          GROUP BY ${quote(column)}`);
      for (const r of rows) {
        strayTotal += r.n;
        strayDetails.push(`${table}.${column}=${r.v} (${r.n})`);
      }
    }
    check(
      `no URL/legacy/wrapped connector_id remains in any active column`,
      strayTotal === 0,
      strayDetails.join('; '),
    );

    // 2d. records moved to canonical keys (gmail URL -> gmail, codex wrapped -> codex).
    const gmailRecs = await scalar(pool,
      `SELECT COUNT(*)::int FROM records WHERE connector_id = 'gmail'`);
    check(`records hydrate under canonical 'gmail'`, gmailRecs === 2, `count=${gmailRecs}`);
    const codexRecs = await scalar(pool,
      `SELECT COUNT(*)::int FROM records WHERE connector_id = 'codex'`);
    check(`records hydrate under canonical 'codex' (local-device unwrapped)`, codexRecs === 1, `count=${codexRecs}`);

    // --- 3. grants + package membership preserved --------------------
    const grantIds = (await pool.query(
      `SELECT grant_id FROM grants ORDER BY grant_id`)).rows.map((r) => r.grant_id);
    check(`all 3 grants preserved`,
      JSON.stringify(grantIds) === JSON.stringify(['grant_claude_1', 'grant_gmail_1', 'grant_spotify_1']),
      grantIds.join(','));

    // grant_json.$.source.id canonicalized
    const gmailSourceId = await scalar(pool,
      `SELECT grant_json->'source'->>'id' FROM grants WHERE grant_id = 'grant_gmail_1'`);
    check(`grant_gmail_1 grant_json.source.id -> 'gmail'`, gmailSourceId === 'gmail', `got ${gmailSourceId}`);
    const claudeSourceId = await scalar(pool,
      `SELECT grant_json->'source'->>'id' FROM grants WHERE grant_id = 'grant_claude_1'`);
    check(`grant_claude_1 grant_json.source.id -> 'claude-code'`, claudeSourceId === 'claude-code', `got ${claudeSourceId}`);
    // storage_binding_json.$.connector_id canonicalized
    const gmailStorageId = await scalar(pool,
      `SELECT storage_binding_json->>'connector_id' FROM grants WHERE grant_id = 'grant_gmail_1'`);
    check(`grant_gmail_1 storage_binding_json.connector_id -> 'gmail'`, gmailStorageId === 'gmail', `got ${gmailStorageId}`);

    // grant_package_members.source_json.$.id canonicalized; membership intact
    const memberCount = await scalar(pool,
      `SELECT COUNT(*)::int FROM grant_package_members WHERE package_id = 'pkg_1'`);
    check(`grant package pkg_1 still has 2 members`, memberCount === 2, `count=${memberCount}`);
    const memberGmailId = await scalar(pool,
      `SELECT source_json->>'id' FROM grant_package_members WHERE grant_id = 'grant_gmail_1'`);
    check(`pkg member (gmail) source_json.id -> 'gmail'`, memberGmailId === 'gmail', `got ${memberGmailId}`);
    // connection_id (unrelated field) preserved
    const memberConn = await scalar(pool,
      `SELECT source_json->>'connection_id' FROM grant_package_members WHERE grant_id = 'grant_gmail_1'`);
    check(`pkg member connection_id preserved`, memberConn === 'cin_gmail_01', `got ${memberConn}`);

    // pending_consents JSONB canonicalized
    const pcSource = await scalar(pool,
      `SELECT params_json->'source_binding'->>'id' FROM pending_consents WHERE device_code = 'dev_code_1'`);
    check(`pending_consents source_binding.id -> 'gmail'`, pcSource === 'gmail', `got ${pcSource}`);
    const pcStorage = await scalar(pool,
      `SELECT params_json->'storage_binding'->>'connector_id' FROM pending_consents WHERE device_code = 'dev_code_1'`);
    check(`pending_consents storage_binding.connector_id -> 'gmail'`, pcStorage === 'gmail', `got ${pcStorage}`);

    // --- 4. record hydration (join records -> instances under canonical key) ---
    const hydrated = await scalar(pool,
      `SELECT COUNT(*)::int FROM records r
         JOIN connector_instances ci ON ci.connector_instance_id = r.connector_instance_id
        WHERE r.connector_id = ci.connector_id`);
    // After migration both sides agree on canonical key for gmail/codex/spotify.
    check(`all 4 records join instances on agreeing canonical connector_id`, hydrated === 4, `joined=${hydrated}`);
    // Record payload still readable & unchanged.
    const subj = await scalar(pool,
      `SELECT record_json->>'subject' FROM records WHERE connector_id='gmail' AND record_key='msg_1'`);
    check(`record payload intact after migration`, subj === 'Welcome', `got ${subj}`);
    // version_counter / connector_state / blobs followed the rewrite.
    const vc = await scalar(pool,
      `SELECT max_version FROM version_counter WHERE connector_id='gmail' AND stream='messages'`);
    check(`version_counter rewritten to canonical`, Number(vc) === 2, `got ${vc}`);
    const blobConn = await scalar(pool,
      `SELECT connector_id FROM blobs WHERE blob_id='blob_gmail_1'`);
    check(`blobs.connector_id rewritten to canonical`, blobConn === 'gmail', `got ${blobConn}`);
    const bindConn = await scalar(pool,
      `SELECT connector_id FROM blob_bindings WHERE blob_id='blob_gmail_1'`);
    check(`blob_bindings.connector_id rewritten to canonical`, bindConn === 'gmail', `got ${bindConn}`);

    // --- negative control: backup-tier table left untouched ----------
    const backupVal = await scalar(pool,
      `SELECT connector_id FROM backup_20260601_seed_records WHERE id=1`);
    check(`backup-tier table NOT rewritten (still URL)`, backupVal === URL_GMAIL, `got ${backupVal}`);
  } finally {
    await pool.end();
  }

  const failed = checks.filter((c) => !c.pass);
  process.stdout.write('# §3.4 backup/restore verification\n');
  for (const c of checks) {
    process.stdout.write(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? '  [' + c.detail + ']' : ''}\n`);
  }
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) process.exit(1);
}

function quote(id) {
  return `"${String(id).replace(/"/g, '""')}"`;
}
async function scalar(pool, sql, params) {
  const { rows } = await pool.query(sql, params);
  const r = rows[0];
  return r ? r[Object.keys(r)[0]] : null;
}
async function activeConnectorIdColumns(pool) {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'connector_id'`);
  // exclude backup_/cleanup_/compact_*_backup_/fix_/mig_ tiers (mirror inspect.mjs taxonomy)
  return rows
    .map((r) => ({ table: r.table_name, column: r.column_name }))
    .filter(({ table }) =>
      !/^cleanup_\d{8}_/.test(table) &&
      !/^backup_\d{8}_/.test(table) &&
      !/^compact_.+_backup_/.test(table) &&
      !/^(fix|mig)_\d{8}_\d{4,6}_/.test(table));
}

main().catch((err) => {
  process.stderr.write(`verify error: ${err.message}\n`);
  process.exit(1);
});
