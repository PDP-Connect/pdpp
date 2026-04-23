#!/usr/bin/env node
/**
 * Post-run verification: reads the persistent polyfill.sqlite and prints
 * record counts per (connector, stream). Also checks DB spine for completed
 * runs.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: @databases/sqlite is declared in package.json; tsc resolves it correctly
import connect, { sql } from "@databases/sqlite";

interface CountRow {
  connector_id: string;
  n: number;
  stream: string;
}

interface RunRow {
  events: number;
  run_id: string;
  status: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", ".pdpp-data", "polyfill.sqlite");
const CONNECTOR_REGISTRY_PREFIX = /^https:\/\/registry\.pdpp\.org\/connectors\//;

async function main(): Promise<void> {
  const db = connect(DB_PATH);

  try {
    const counts = (await db.query(sql`
      SELECT connector_id, stream, COUNT(*) AS n
      FROM records
      GROUP BY connector_id, stream
      ORDER BY connector_id, stream
    `)) as CountRow[];
    console.log("\nRecords per (connector, stream):");
    for (const r of counts) {
      const short = r.connector_id.replace(CONNECTOR_REGISTRY_PREFIX, "");
      console.log(`  ${short.padEnd(14)} ${r.stream.padEnd(26)} ${r.n}`);
    }
    const total = counts.reduce((s: number, r: CountRow) => s + r.n, 0);
    console.log(`\nTotal records: ${total}`);

    const runs = (await db.query(sql`
      SELECT run_id, status, COUNT(*) AS events
      FROM spine_events
      WHERE run_id IS NOT NULL AND run_id != ''
      GROUP BY run_id, status
      ORDER BY MAX(occurred_at) DESC
      LIMIT 10
    `)) as RunRow[];
    console.log("\nRecent runs:");
    for (const r of runs) {
      console.log(`  ${r.run_id}  ${r.status}  ${r.events} events`);
    }
  } finally {
    // @databases/sqlite's db may not have explicit close; not critical for short script
  }
}
main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
