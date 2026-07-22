#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Replay every committed record in the local pdpp.sqlite through the
 * matching connector's `validateRecord`. Reports pass/skip counts per
 * (connector, stream) and writes a JSON report under `local/`.
 *
 * Usage:
 *   pnpm exec tsx bin/replay-schemas.ts [connector_short_name ...]
 *
 *   # Replay every connector that has a schemas.ts:
 *   pnpm exec tsx bin/replay-schemas.ts
 *
 *   # Replay just one or two:
 *   pnpm exec tsx bin/replay-schemas.ts amazon reddit
 *
 * The connector short-name maps to its directory under `connectors/<name>/`
 * (e.g. `claude_code`, `claude-code` for matching connector_id slugs is
 * normalized below). Output goes to local/schema-replay-<connector>-<ts>.json.
 *
 * This is a diagnostic tool — it does not modify the DB and exits 0
 * unless a connector lookup actively errors.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const CONNECTOR_ID_TAIL_RE = /\/([^/]+)$/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const DB_PATH = join(PKG_ROOT, ".pdpp-data", "pdpp.sqlite");
const REPORT_DIR = join(PKG_ROOT, "local");

interface ReplayIssue {
  message: string;
  path: string;
}

interface ReplayFailure {
  id: unknown;
  issues: ReplayIssue[];
  record: Record<string, unknown>;
}

interface StreamReport {
  examples: ReplayFailure[];
  failed: number;
  failure_messages: Record<string, number>;
  passed: number;
  total: number;
}

interface ConnectorReport {
  connector: string;
  generated_at: string;
  has_schema: boolean;
  streams: Record<string, StreamReport>;
}

const CONNECTOR_DIR_BY_SLUG: Record<string, string> = {
  amazon: "amazon",
  chase: "chase",
  chatgpt: "chatgpt",
  "claude-code": "claude_code",
  claude_code: "claude_code",
  codex: "codex",
  github: "github",
  gmail: "gmail",
  reddit: "reddit",
  slack: "slack",
  spotify: "spotify",
  usaa: "usaa",
  ynab: "ynab",
};

function connectorIdToSlug(connectorId: string): string {
  const m = CONNECTOR_ID_TAIL_RE.exec(connectorId);
  return m?.[1] ?? connectorId;
}

async function loadValidator(
  dirName: string
): Promise<
  ((stream: string, data: Record<string, unknown>) => { ok: true } | { ok: false; issues: ReplayIssue[] }) | null
> {
  const schemaPath = join(PKG_ROOT, "connectors", dirName, "schemas.ts");
  try {
    const mod = (await import(schemaPath)) as {
      validateRecord?: (
        stream: string,
        data: Record<string, unknown>
      ) => { ok: true } | { ok: false; issues: ReplayIssue[] };
    };
    return mod.validateRecord ?? null;
  } catch {
    return null;
  }
}

interface Row {
  connector_id: string;
  record_json: string;
  stream: string;
}

async function replayConnector(db: Database.Database, slug: string): Promise<ConnectorReport> {
  const dirName = CONNECTOR_DIR_BY_SLUG[slug] ?? slug;
  const validate = await loadValidator(dirName);
  const report: ConnectorReport = {
    connector: dirName,
    generated_at: new Date().toISOString(),
    has_schema: validate !== null,
    streams: {},
  };

  if (!validate) {
    return report;
  }

  // Use LIKE so we match either path-style (".../connectors/x") or
  // dash-style (".../claude-code") connector_ids.
  const rows = db
    .prepare(
      "SELECT connector_id, stream, record_json FROM records WHERE deleted = 0 AND connector_id LIKE ? ORDER BY stream, emitted_at"
    )
    .all(`%/${slug.replace(/_/g, "%")}%`) as Row[];

  // Filter to exact short-name match to avoid e.g. "chatgpt" matching
  // "chatgpt-extension" if some such id existed.
  const filtered = rows.filter((r) => connectorIdToSlug(r.connector_id) === slug);

  for (const row of filtered) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.record_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    let s = report.streams[row.stream];
    if (!s) {
      s = { total: 0, passed: 0, failed: 0, failure_messages: {}, examples: [] };
      report.streams[row.stream] = s;
    }
    s.total++;
    const result = validate(row.stream, data);
    if (result.ok) {
      s.passed++;
      continue;
    }
    s.failed++;
    for (const issue of result.issues) {
      const key = `${issue.path}: ${issue.message}`;
      s.failure_messages[key] = (s.failure_messages[key] ?? 0) + 1;
    }
    if (s.examples.length < 5) {
      s.examples.push({ id: data.id ?? null, issues: result.issues, record: data });
    }
  }

  return report;
}

interface ReplayTotals {
  failed: number;
  passed: number;
  total: number;
}

interface ReplaySummary {
  connector: string;
  streams: Record<string, ReplayTotals>;
}

function totalsFor(report: ConnectorReport): ReplayTotals {
  return Object.values(report.streams).reduce<ReplayTotals>(
    (acc, s) => ({ total: acc.total + s.total, passed: acc.passed + s.passed, failed: acc.failed + s.failed }),
    { total: 0, passed: 0, failed: 0 }
  );
}

function printStreamLine(stream: string, s: StreamReport): void {
  const pct = s.total > 0 ? ((s.passed / s.total) * 100).toFixed(2) : "n/a";
  const flag = s.failed > 0 ? "✖" : "✓";
  console.log(`  ${flag} ${stream}: ${s.passed}/${s.total} (${pct}%)`);
  if (s.failed > 0) {
    const top = Object.entries(s.failure_messages)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);
    for (const [msg, count] of top) {
      console.log(`      ${count}× ${msg}`);
    }
  }
}

function reportToSummary(report: ConnectorReport): ReplaySummary {
  return {
    connector: report.connector,
    streams: Object.fromEntries(
      Object.entries(report.streams).map(([k, v]) => [k, { total: v.total, passed: v.passed, failed: v.failed }])
    ),
  };
}

function writeAndPrintReport(report: ConnectorReport, totals: ReplayTotals): void {
  const ts = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const reportPath = join(REPORT_DIR, `schema-replay-${report.connector}-${ts}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`# ${report.connector}  ${totals.passed}/${totals.total} pass  (${totals.failed} fail)  → ${reportPath}`);
  for (const [stream, s] of Object.entries(report.streams).sort()) {
    printStreamLine(stream, s);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const slugs = args.length > 0 ? args : Object.keys(CONNECTOR_DIR_BY_SLUG);

  mkdirSync(REPORT_DIR, { recursive: true });
  const db = new Database(DB_PATH, { readonly: true });

  const summaries: ReplaySummary[] = [];

  for (const slug of slugs) {
    const report = await replayConnector(db, slug);
    if (!report.has_schema) {
      console.log(`# ${report.connector} — no schemas.ts; skipping`);
      continue;
    }
    const totals = totalsFor(report);
    if (totals.total === 0) {
      console.log(`# ${report.connector} — no records in DB`);
      continue;
    }
    writeAndPrintReport(report, totals);
    summaries.push(reportToSummary(report));
  }

  db.close();
  const summaryPath = join(REPORT_DIR, "schema-replay-summary.json");
  writeFileSync(summaryPath, JSON.stringify(summaries, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
