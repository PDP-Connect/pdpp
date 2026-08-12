// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the read-only batch dry-run wrapper
 * `compact-record-history-dry-run-all.ts`.
 *
 * All pure: scope resolution, table formatting, and the DB-backed
 * functions are exercised against a fake pool so no Postgres is required.
 * The wrapper deliberately has no `--apply` path; the safety assertion
 * here is that it only ever calls the read-only `planCompaction` and a
 * SELECT-only pool.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import type pg from "pg";
import type { CompactionPlan, PlanCompactionInput } from "../scripts/compact-record-history.ts";
import { COMPACTION_POLICIES } from "../scripts/compact-record-history.ts";
import {
  type DryRunRow,
  formatDryRunTable,
  listConnectionsWithPolicies,
  parseArgs,
  policiesForConnector,
  resolveConnectorId,
  runDryRuns,
  totalRemovableVersions,
} from "../scripts/compact-record-history-dry-run-all.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Fake pool ──────────────────────────────────────────────────────────

interface FakePoolHandler {
  match: (sqlLower: string) => boolean;
  rows: unknown[] | ((params: unknown[]) => unknown[]);
}

interface FakeQuery {
  params: unknown[];
  sql: string;
}

/**
 * Every function under test declares its pool param as the real pg.Pool
 * (its full ~20-member interface), but only ever calls query()/end() on
 * it. Rather than a blanket cast, this narrow structural type documents
 * exactly which two members the fake actually needs to implement and
 * scopes the resulting `pool as pg.Pool` cast (at each call site below) to
 * that already-verified-safe surface.
 */
type FakePgPool = { queries: FakeQuery[] } & Pick<pg.Pool, "query" | "end">;

/**
 * `handlers` is an array of {match(sqlLower) -> bool, rows} probed in
 * order. Records every query so a test can assert no mutation SQL was
 * issued.
 */
function fakePool(handlers: FakePoolHandler[]): FakePgPool {
  const queries: FakeQuery[] = [];
  return {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    end: (async () => {}) as pg.Pool["end"],
    queries,
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    query: (async (sql: string, params: unknown[]) => {
      queries.push({ params, sql });
      for (const h of handlers) {
        if (h.match(sql.toLowerCase())) {
          return { rows: typeof h.rows === "function" ? h.rows(params) : h.rows };
        }
      }
      return { rows: [] };
    }) as pg.Pool["query"],
  };
}

/**
 * The single seam where the narrow FakePgPool is handed to functions typed
 * against the full pg.Pool. Widened to Partial<pg.Pool> first (structurally
 * legal, since every field pg.Pool declares is a valid optional-field
 * candidate) so the final assertion to pg.Pool is a same-shape narrowing,
 * not a disjoint-type coercion.
 */
function asPgPool(pool: FakePgPool): pg.Pool {
  const widened: Partial<pg.Pool> = pool;
  return widened as pg.Pool;
}

// ─── parseArgs ────────────────────────────────────────────────────────────

test("parseArgs parses flags and key=value", () => {
  const args = parseArgs(["--all", "--connector-instance-id=cin_1", "--json"]);
  assert.equal(args.all, true);
  assert.equal(args["connector-instance-id"], "cin_1");
  assert.equal(args.json, true);
});

// ─── policiesForConnector ─────────────────────────────────────────────────

test("policiesForConnector returns every registered policy for a connector_id", () => {
  const usaa = policiesForConnector("cin_usaa", "usaa");
  // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
  const streams = usaa.map((s) => s.stream).sort();
  // From the registry: accounts, credit_card_billing, inbox_messages, statements, transactions.
  assert.deepEqual(streams, ["accounts", "credit_card_billing", "inbox_messages", "statements", "transactions"]);
  for (const scope of usaa) {
    assert.equal(scope.connectorInstanceId, "cin_usaa");
    assert.equal(scope.connectorId, "usaa");
    assert.ok(scope.policy, "each scope carries its policy");
  }
});

test("policiesForConnector matches registry-URL connector ids too", () => {
  const byUrl = policiesForConnector("cin_gmail", "https://registry.pdpp.dev/connectors/gmail");
  // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
  const streams = byUrl.map((s) => s.stream).sort();
  // gmail registry policies: threads, labels.
  assert.deepEqual(streams, ["labels", "threads"]);
});

test("policiesForConnector returns empty for a connector with no policy", () => {
  assert.deepEqual(policiesForConnector("cin_x", "no-such-connector"), []);
});

test("policiesForConnector matches claude-code (hyphen) connector id", () => {
  // The live DB uses connector_id = 'claude-code' (hyphen). An earlier version of
  // the policy builder used 'claude_code' (underscore), which never matched and
  // silently excluded all claude-code instances from --all scans.
  const cc = policiesForConnector("cin_cc", "claude-code");
  // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
  const streams = cc.map((s) => s.stream).sort();
  assert.deepEqual(streams, [
    "attachments",
    "backup_inventory",
    "cache_inventory",
    "config_inventory",
    "file_history",
    "memory_notes",
    "messages",
    "sessions",
    "skills",
    "slash_commands",
  ]);
  for (const scope of cc) {
    assert.equal(scope.connectorInstanceId, "cin_cc");
    assert.equal(scope.connectorId, "claude-code");
  }
});

// ─── resolveConnectorId ────────────────────────────────────────────────────

test("resolveConnectorId reads connector_id from connector_instances", async () => {
  const pool = fakePool([{ match: (s) => s.includes("from connector_instances"), rows: [{ connector_id: "usaa" }] }]);
  assert.equal(await resolveConnectorId(asPgPool(pool), "cin_usaa"), "usaa");
});

test("resolveConnectorId returns null for an unknown connection", async () => {
  const pool = fakePool([{ match: (s) => s.includes("from connector_instances"), rows: [] }]);
  assert.equal(await resolveConnectorId(asPgPool(pool), "cin_missing"), null);
});

// ─── listConnectionsWithPolicies ───────────────────────────────────────────

test("listConnectionsWithPolicies passes only policy-eligible connector ids", async () => {
  let capturedParams: unknown[] | null = null;
  const pool = fakePool([
    {
      match: (s) => s.includes("from connector_instances"),
      rows: (params) => {
        capturedParams = params;
        return [
          { connector_id: "usaa", connector_instance_id: "cin_usaa" },
          { connector_id: "gmail", connector_instance_id: "cin_gmail" },
        ];
      },
    },
  ]);
  const conns = await listConnectionsWithPolicies(asPgPool(pool));
  assert.equal(conns.length, 2);
  assert.ok(capturedParams);
  // The IN-list is the union of every registered connectorIds entry.
  const expected = new Set(COMPACTION_POLICIES.flatMap((p) => p.connectorIds));
  assert.deepEqual(new Set(capturedParams[0]), expected);
});

// ─── runDryRuns ────────────────────────────────────────────────────────────

/** Builds a fully-valid CompactionPlan; runDryRuns only ever stores the plan wholesale, so unused fields get plausible constants. */
function makePlan(
  overrides: Partial<CompactionPlan> & Pick<CompactionPlan, "connectorInstanceId" | "stream">
): CompactionPlan {
  return {
    connectorIdsSeen: ["usaa"],
    estimatedRemovedBytes: 0,
    mode: "audit",
    removableByKey: new Map(),
    removableVersions: 0,
    retainedVersionsAfter: 0,
    scannedKeys: 3,
    scannedVersions: 30,
    ...overrides,
  };
}

test("runDryRuns calls the injected plan fn once per scope and never mutates", async () => {
  const pool = fakePool([]); // planFn is injected, so the pool is untouched here
  const planCalls: { connectorInstanceId: string; stream: string }[] = [];
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const planFn = async ({ connectorInstanceId, stream }: PlanCompactionInput): Promise<CompactionPlan> => {
    planCalls.push({ connectorInstanceId, stream });
    return makePlan({
      connectorInstanceId,
      estimatedRemovedBytes: stream === "statements" ? 5400 : 0,
      removableVersions: stream === "statements" ? 27 : 0,
      stream,
    });
  };
  const scopes = policiesForConnector("cin_usaa", "usaa");
  const rows = await runDryRuns({ planFn, pool: asPgPool(pool), scopes });

  // usaa now has 5 registered policies: accounts, credit_card_billing, inbox_messages, statements, transactions.
  assert.equal(rows.length, 5);
  assert.equal(planCalls.length, 5);
  assert.equal(totalRemovableVersions(rows), 27);
  // No SQL issued through the pool by runDryRuns itself.
  assert.equal(pool.queries.length, 0);
});

test("runDryRuns records a per-scope error instead of throwing", async () => {
  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const planFn = async ({ connectorInstanceId, stream }: PlanCompactionInput): Promise<CompactionPlan> => {
    if (stream === "accounts") {
      throw new Error("relation record_changes missing");
    }
    return makePlan({ connectorInstanceId, scannedVersions: 10, stream });
  };
  const scopes = policiesForConnector("cin_usaa", "usaa");
  const rows = await runDryRuns({ planFn, pool: asPgPool(fakePool([])), scopes });
  const errored = rows.find((r) => r.error);
  assert.ok(errored, "an errored scope is present");
  assert.equal(errored.stream, "accounts");
  assert.ok(errored.error);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(errored.error, /record_changes missing/);
  // Other 4 scopes (credit_card_billing, inbox_messages, statements, transactions) still planned.
  assert.equal(rows.filter((r) => !r.error).length, 4);
});

// ─── formatDryRunTable / totalRemovableVersions ────────────────────────────

test("formatDryRunTable renders aligned rows including errors", () => {
  const rows: DryRunRow[] = [
    {
      connectorId: "usaa",
      connectorInstanceId: "cin_usaa",
      plan: makePlan({
        connectorInstanceId: "cin_usaa",
        estimatedRemovedBytes: 5400,
        removableVersions: 27,
        scannedVersions: 30,
        stream: "statements",
      }),
      stream: "statements",
    },
    { connectorId: "usaa", connectorInstanceId: "cin_usaa", error: "boom", stream: "accounts" },
  ];
  const table = formatDryRunTable(rows);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(table, /connection/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(table, /statements/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(table, /27/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(table, /ERROR/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(table, /boom/);
});

test("totalRemovableVersions sums non-error rows only", () => {
  const rows: DryRunRow[] = [
    {
      connectorId: "a",
      connectorInstanceId: "cin_a",
      plan: makePlan({ connectorInstanceId: "cin_a", removableVersions: 27, stream: "s1" }),
      stream: "s1",
    },
    {
      connectorId: "a",
      connectorInstanceId: "cin_a",
      plan: makePlan({ connectorInstanceId: "cin_a", removableVersions: 5, stream: "s2" }),
      stream: "s2",
    },
    { connectorId: "a", connectorInstanceId: "cin_a", error: "x", stream: "s3" },
  ];
  assert.equal(totalRemovableVersions(rows), 32);
});

// ─── No-apply / no-mutation static guard ───────────────────────────────────

test("the wrapper source contains no DELETE/INSERT/UPDATE and no --apply wiring", () => {
  const src = readFileSync(path.resolve(__dirname, "..", "scripts", "compact-record-history-dry-run-all.ts"), "utf8");
  // No write SQL anywhere in the wrapper.
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(src, /\b(DELETE|INSERT|UPDATE)\b/i, "wrapper issues no write SQL");
  // It must not import or call applyCompaction.
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(src, /applyCompaction/, "wrapper never references applyCompaction");
  // --apply is explicitly refused, not honored.
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(src, /does not support --apply/, "wrapper explicitly refuses --apply");
});

test("compaction utilities are safe to import from node -e contexts", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  for (const rel of [
    "reference-implementation/scripts/compact-record-history.ts",
    "reference-implementation/scripts/compact-record-history-dry-run-all.ts",
  ]) {
    const child = spawnSync(process.execPath, ["-e", `import('./${rel}').then(() => console.log('ok'))`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, `${rel} import failed: ${child.stderr || child.stdout}`);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(child.stdout, /ok/);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.doesNotMatch(child.stderr, /usage:|PDPP_DATABASE_URL|compact-record-history failed/i);
  }
});
