#!/usr/bin/env node

/**
 * Validate every record in the local DB against its connector's
 * current Zod schema. Surfaces schema-vs-reality mismatches without
 * needing to re-run any connector.
 *
 * Uses sqlite3 CLI (universal) to dump records to JSONL, then streams
 * them through each connector's validator. No SQLite node binding
 * needed.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_PATH =
  process.env.PDPP_DB_PATH || join(homedir(), "code/pdpp/packages/polyfill-connectors/.pdpp-data/pdpp.sqlite");

interface ValidateResult {
  data: Record<string, unknown>;
  ok: true;
}
interface ValidateError {
  issues: Array<{ path: string; message: string }>;
  ok: false;
}
type ValidateReturn = ValidateResult | ValidateError;

interface SchemasModule {
  SCHEMAS: Record<string, unknown>;
  validateRecord: (stream: string, data: Record<string, unknown>) => ValidateReturn;
}

const CONNECTORS: Record<string, SchemasModule> = {
  "https://registry.pdpp.org/connectors/amazon": (await import("../connectors/amazon/schemas.ts")) as SchemasModule,
  "https://registry.pdpp.org/connectors/chase": (await import("../connectors/chase/schemas.ts")) as SchemasModule,
  "https://registry.pdpp.org/connectors/chatgpt": (await import("../connectors/chatgpt/schemas.ts")) as SchemasModule,
  "https://registry.pdpp.org/connectors/usaa": (await import("../connectors/usaa/schemas.ts")) as SchemasModule,
};

interface DbRow {
  json: string;
  key: string;
}

function fetchRecords(connectorId: string, stream: string): DbRow[] {
  // Emit as tab-separated key\t<raw-json> so we can split cleanly
  const sql = `SELECT record_key || CHAR(9) || record_json FROM records
               WHERE connector_id='${connectorId}' AND stream='${stream}' AND deleted=0;`;
  const result = spawnSync("sqlite3", [DB_PATH, sql], {
    encoding: "utf8",
    maxBuffer: 500 * 1024 * 1024, // 500 MB
  });
  if (result.status !== 0) {
    console.error(`sqlite3 err: ${result.stderr?.slice(0, 200)}`);
    return [];
  }
  const rows: DbRow[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    rows.push({ key: line.slice(0, tab), json: line.slice(tab + 1) });
  }
  return rows;
}

interface FailSample {
  issues?: string[];
  key: string;
  reason?: string;
}

interface StreamSummary {
  fail: number;
  failSamples: FailSample[];
  issueCountByPath: Record<string, number>;
  pass: number;
}

const summary: Record<string, Record<string, StreamSummary>> = {};
for (const [connectorId, schemasMod] of Object.entries(CONNECTORS)) {
  const { validateRecord, SCHEMAS } = schemasMod;
  const name = connectorId.split("/").pop() ?? connectorId;
  summary[name] = {};

  for (const stream of Object.keys(SCHEMAS)) {
    const rows = fetchRecords(connectorId, stream);
    let pass = 0;
    let fail = 0;
    const failSamples: FailSample[] = [];
    const issueCountByPath: Record<string, number> = {};
    for (const row of rows) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(row.json);
      } catch {
        fail++;
        if (failSamples.length < 3) {
          failSamples.push({ key: row.key, reason: "invalid JSON" });
        }
        continue;
      }
      const res = validateRecord(stream, data);
      if (res.ok) {
        pass++;
        continue;
      }
      fail++;
      for (const i of res.issues) {
        const k = `${i.path}: ${i.message}`;
        issueCountByPath[k] = (issueCountByPath[k] || 0) + 1;
      }
      if (failSamples.length < 3) {
        failSamples.push({
          key: row.key,
          issues: res.issues.map((i) => `${i.path}: ${i.message}`).slice(0, 5),
        });
      }
    }
    summary[name][stream] = { pass, fail, issueCountByPath, failSamples };
  }
}

// Pretty print
console.log("\n════════════ SCHEMA AUDIT ════════════");
console.log(`DB: ${DB_PATH}\n`);
for (const [conn, streams] of Object.entries(summary)) {
  console.log(`┌─ ${conn}`);
  for (const [stream, result] of Object.entries(streams)) {
    const total = result.pass + result.fail;
    const pct = total ? Math.round((result.pass / total) * 100) : 0;
    let status: string;
    if (total === 0) {
      status = "—";
    } else if (result.fail === 0) {
      status = "✅";
    } else if (result.pass === 0) {
      status = "❌";
    } else {
      status = "⚠ ";
    }
    console.log(`│  ${status} ${stream.padEnd(28)} ${result.pass}/${total} pass (${pct}%)`);
    if (result.fail > 0) {
      const issues = Object.entries(result.issueCountByPath)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      for (const [issue, count] of issues) {
        console.log(`│     [${count}×] ${issue}`);
      }
    }
  }
  console.log("└─");
}

// Exit non-zero if any failures found (for CI use)
const totalFail = Object.values(summary)
  .flatMap((s) => Object.values(s))
  .reduce((a, r) => a + r.fail, 0);
process.exit(totalFail > 0 ? 1 : 0);
