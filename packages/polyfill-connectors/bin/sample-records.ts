#!/usr/bin/env node
/**
 * Sample N representative records per stream for a connector and
 * write them to a JSON file. Used to feed schema-authoring agents
 * grounded examples instead of hand-crafted hypotheticals.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: tsx resolves better-sqlite3 at runtime.
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const DB_PATH = join(PKG_ROOT, ".pdpp-data", "pdpp.sqlite");
const OUT_DIR = join(PKG_ROOT, "local", "samples");

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: sample-records.ts <slug> [<slug> ...]");
  process.exit(1);
}
const PER_STREAM = 5;

mkdirSync(OUT_DIR, { recursive: true });
const db = new Database(DB_PATH, { readonly: true });

for (const slug of args) {
  const connectorId = `https://registry.pdpp.org/connectors/${slug}`;
  const streams = db
    .prepare("SELECT DISTINCT stream FROM records WHERE deleted=0 AND connector_id = ? ORDER BY stream")
    .all(connectorId) as { stream: string }[];

  const byStream: Record<string, Record<string, unknown>[]> = {};
  for (const s of streams) {
    const rows = db
      .prepare(
        "SELECT record_json FROM records WHERE deleted=0 AND connector_id = ? AND stream = ? ORDER BY RANDOM() LIMIT ?"
      )
      .all(connectorId, s.stream, PER_STREAM) as { record_json: string }[];
    byStream[s.stream] = rows.map((r) => JSON.parse(r.record_json) as Record<string, unknown>);
  }

  const out = join(OUT_DIR, `${slug}.json`);
  writeFileSync(out, JSON.stringify(byStream, null, 2));
  console.log(
    `${slug}: ${Object.keys(byStream).length} streams, ${Object.values(byStream).reduce((n, a) => n + a.length, 0)} records → ${out}`
  );
}

db.close();
