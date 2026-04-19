#!/usr/bin/env node
/**
 * Post-run verification: reads the persistent polyfill.sqlite and prints
 * record counts per (connector, stream). Also checks DB spine for completed
 * runs.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '@databases/sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '.pdpp-data', 'polyfill.sqlite');

async function main() {
  const { default: createDatabase, sql } = Database;
  // @databases/sqlite default export is the create function
  const db = (typeof Database === 'function' ? Database : createDatabase)(DB_PATH);

  try {
    const counts = await db.query(sql`
      SELECT connector_id, stream, COUNT(*) AS n
      FROM records
      GROUP BY connector_id, stream
      ORDER BY connector_id, stream
    `);
    console.log('\nRecords per (connector, stream):');
    for (const r of counts) {
      const short = r.connector_id.replace(/^https:\/\/registry\.pdpp\.org\/connectors\//, '');
      console.log(`  ${short.padEnd(14)} ${r.stream.padEnd(26)} ${r.n}`);
    }
    const total = counts.reduce((s, r) => s + r.n, 0);
    console.log(`\nTotal records: ${total}`);

    const runs = await db.query(sql`
      SELECT run_id, status, COUNT(*) AS events
      FROM spine_events
      WHERE run_id IS NOT NULL AND run_id != ''
      GROUP BY run_id, status
      ORDER BY MAX(occurred_at) DESC
      LIMIT 10
    `);
    console.log('\nRecent runs:');
    for (const r of runs) console.log(`  ${r.run_id}  ${r.status}  ${r.events} events`);
  } finally {
    // @databases/sqlite's db may not have explicit close; not critical for short script
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
