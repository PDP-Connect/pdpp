#!/usr/bin/env node
/**
 * Replay every committed pilot-real-shape fixture through its connector's
 * `validateRecord`. Fails fast on schema drift. Used as a one-shot
 * verification after fixture authoring; the equivalent test runner lives
 * in connectors/<name>/parsers.test.ts (or integration.test.ts) once
 * each connector adopts the pattern.
 *
 * Usage:
 *   pnpm exec tsx bin/replay-pilot-fixtures.ts                # all
 *   pnpm exec tsx bin/replay-pilot-fixtures.ts github gmail   # subset
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const FIXTURES_DIR = join(PKG_ROOT, "fixtures");
const CONNECTORS_DIR = join(PKG_ROOT, "connectors");
const JSONL_EXT_RE = /\.jsonl$/;

interface ValidatorResult {
  issues?: { path: string; message: string }[];
  ok: boolean;
}

type ValidateRecord = (stream: string, data: Record<string, unknown>) => ValidatorResult;

async function loadValidator(connector: string): Promise<ValidateRecord | null> {
  const schemaPath = join(CONNECTORS_DIR, connector, "schemas.ts");
  if (!existsSync(schemaPath)) {
    return null;
  }
  const mod = (await import(schemaPath)) as { validateRecord?: ValidateRecord };
  return mod.validateRecord ?? null;
}

interface StreamReplay {
  failed: number;
  failures: Array<{ id: unknown; issues: { path: string; message: string }[] }>;
  passed: number;
  total: number;
}

async function replayConnector(connector: string): Promise<Record<string, StreamReplay> | null> {
  const recordsDir = join(FIXTURES_DIR, connector, "scrubbed", "pilot-real-shape", "records");
  if (!existsSync(recordsDir)) {
    return null;
  }
  const validator = await loadValidator(connector);
  if (!validator) {
    return null;
  }
  const out: Record<string, StreamReplay> = {};
  for (const filename of readdirSync(recordsDir).sort()) {
    if (!filename.endsWith(".jsonl")) {
      continue;
    }
    const stream = filename.replace(JSONL_EXT_RE, "");
    const lines = readFileSync(join(recordsDir, filename), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    const result: StreamReplay = { total: 0, passed: 0, failed: 0, failures: [] };
    for (const line of lines) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(line) as Record<string, unknown>;
      } catch {
        result.total++;
        result.failed++;
        result.failures.push({ id: null, issues: [{ path: "", message: "invalid JSONL line" }] });
        continue;
      }
      result.total++;
      const v = validator(stream, data);
      if (v.ok) {
        result.passed++;
      } else {
        result.failed++;
        result.failures.push({ id: data.id ?? null, issues: v.issues ?? [] });
      }
    }
    out[stream] = result;
  }
  return out;
}

function printStreamFailures(stream: string, s: StreamReplay): void {
  console.log(`    ✖ ${stream}: ${s.passed}/${s.total}`);
  for (const f of s.failures.slice(0, 3)) {
    console.log(`        id=${JSON.stringify(f.id)}`);
    for (const i of f.issues.slice(0, 5)) {
      console.log(`          ${i.path}: ${i.message}`);
    }
  }
}

function printConnectorReport(name: string, r: Record<string, StreamReplay>): number {
  let drift = 0;
  const totals = Object.values(r).reduce(
    (acc, s) => ({ total: acc.total + s.total, passed: acc.passed + s.passed, failed: acc.failed + s.failed }),
    { total: 0, passed: 0, failed: 0 }
  );
  const flag = totals.failed > 0 ? "✖" : "✓";
  console.log(`${flag} ${name}: ${totals.passed}/${totals.total}`);
  for (const [stream, s] of Object.entries(r).sort()) {
    if (s.failed > 0) {
      drift += s.failed;
      printStreamFailures(stream, s);
    } else {
      console.log(`    ✓ ${stream}: ${s.passed}/${s.total}`);
    }
  }
  return drift;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targets =
    argv.length > 0
      ? argv
      : readdirSync(FIXTURES_DIR).filter((d) =>
          existsSync(join(FIXTURES_DIR, d, "scrubbed", "pilot-real-shape", "records"))
        );
  let totalDrift = 0;
  for (const name of targets) {
    const r = await replayConnector(name);
    if (r === null) {
      console.log(`# ${name} — no pilot-real-shape fixtures or no schemas.ts; skipping`);
      continue;
    }
    if (printConnectorReport(name, r) > 0) {
      totalDrift++;
    }
  }
  console.log(`\n${targets.length} connectors checked, ${totalDrift} with fixture drift`);
  if (totalDrift > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
