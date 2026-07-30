// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Structural invariants for the console's `/_ref/connectors` pagination
 * migration (root cause: every console caller omitted `limit`/`cursor` and
 * always hit the reference's unbounded compatibility fan-out).
 *
 * `ref-client.ts` imports `server-only` transitively (via `owner-token.ts`),
 * so its functions cannot execute in a plain `node:test` process the way
 * `data-source.test.ts` documents for the same reason. These tests pin the
 * source-level contract instead, matching that file's established pattern:
 *   - `listConnectorSummaries` unscoped calls always send `limit` (never the
 *     bare unparameterized request that triggers the reference's deprecated
 *     unbounded branch).
 *   - There is no `listAllConnectorSummaries`/exhaustive fold anywhere in
 *     this file — every render path awaits exactly ONE bounded page via
 *     `loadConnectorSummaryPage` (components/connector-summary-page.tsx),
 *     directly executable-tested there and in connector-summary-pager.test.ts.
 *
 * Byte/field parity across page sizes at the HTTP/SQL layer (N=1/N=100/
 * N=1000, revoked rows, duplicate connector ids) is proven server-side in
 * `reference-implementation/test/ref-connectors-list-page-route-parity.test.ts`
 * and `ref-connectors-list-pagination.test.ts` — this file does not
 * duplicate that; it proves the client actually calls the paginated shape
 * those tests characterize.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REF_CLIENT_FILE = `${HERE}ref-client.ts`;
const SELF = fileURLToPath(import.meta.url);
const CONSOLE_DASHBOARD_DIR = join(HERE, "..");

const TS_FILE_RE = /\.(ts|tsx)$/;
const TEST_FILE_RE = /\.test\.(ts|tsx)$/;
// A bare, zero-argument call — the exact shape that always took the
// reference's deprecated unbounded fan-out branch (root cause of the p50
// 11.5s Overview TTFB this migration fixes).
const BARE_UNSCOPED_CALL_RE = /\blistConnectorSummaries\(\s*\)/;
const LIST_ALL_CONNECTOR_SUMMARIES_RE = /\blistAllConnectorSummaries\b/;
const EXHAUSTIVE_FOLD_RE = /\bfoldConnectorSummaryPages\b/;

const SCOPED_BRANCH_GATE_RE = /if\s*\(options\.connectionRouteId\)\s*\{/;
const SCOPED_CONNECTION_PARAM_RE = /connection:\s*options\.connectionRouteId/;
const PAGINATED_LIMIT_PARAM_RE = /limit:\s*options\.limit\s*\?\?\s*CONNECTOR_SUMMARY_DEFAULT_PAGE_LIMIT/;
const PAGINATED_CURSOR_PARAM_RE = /cursor:\s*options\.cursor/;
const REF_FETCH_CALL_RE = /refFetch\("\/_ref\/connectors",\s*\{[^}]*\}\)/g;
const CONNECTION_PARAM_KEY_RE = /connection:/;
const LIMIT_PARAM_KEY_RE = /limit:/;
const CONNECTIONS_SEAM_CALL_RE = /refFetch\("\/_ref\/connections",\s*\{\s*connector_id:\s*connectorId\s*\}\)/;
const NO_LIMIT_PARAM_RE = /\blimit\b/;
const NO_CURSOR_PARAM_RE = /\bcursor\b/;

async function walk(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // biome-ignore lint/performance/noAwaitInLoops: recursive directory walk, no parallelism benefit for a test-only helper.
      await walk(full, files);
    } else if (TS_FILE_RE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function functionBody(src: string, exportSignature: string, nextExportSignature: string): string {
  const start = src.indexOf(exportSignature);
  assert.ok(start >= 0, `${exportSignature} must exist`);
  const end = src.indexOf(nextExportSignature, start);
  assert.ok(end > start, `${nextExportSignature} must follow ${exportSignature}`);
  return src.slice(start, end);
}

test("listConnectorSummaries scopes to ?connection= when a route id is known, else always paginates", async () => {
  const src = await readFile(REF_CLIENT_FILE, "utf8");
  const body = functionBody(
    src,
    "export async function listConnectorSummaries(",
    "export async function getFleetHealthVerdict("
  );

  // Scoped branch: exact connection identity, no pagination params (the
  // reference route rejects limit/cursor alongside ?connection=).
  assert.match(body, SCOPED_BRANCH_GATE_RE);
  assert.match(body, SCOPED_CONNECTION_PARAM_RE);

  // Unscoped branch: must always send `limit` — this is the root-cause fix.
  // The old code sent neither param, which is exactly the branch the
  // reference's `PDPP-Warning: deprecated_unbounded_connector_summary_list`
  // targets. No unscoped call site may regress to omitting `limit`.
  assert.match(body, PAGINATED_LIMIT_PARAM_RE);
  assert.match(body, PAGINATED_CURSOR_PARAM_RE);
});

test("listConnectorSummaries never omits both connection and limit", async () => {
  const src = await readFile(REF_CLIENT_FILE, "utf8");
  const body = functionBody(
    src,
    "export async function listConnectorSummaries(",
    "export async function getFleetHealthVerdict("
  );
  // There must be exactly one refFetch call in each branch (scoped vs. paged);
  // neither may construct a params object with no connection/limit/cursor key.
  const refFetchCalls = body.match(REF_FETCH_CALL_RE) ?? [];
  assert.equal(refFetchCalls.length, 2, "expected exactly one scoped call and one paginated call");
  for (const call of refFetchCalls) {
    const hasConnection = CONNECTION_PARAM_KEY_RE.test(call);
    const hasLimit = LIMIT_PARAM_KEY_RE.test(call);
    assert.ok(hasConnection || hasLimit, `every /_ref/connectors call must carry connection or limit: ${call}`);
  }
});

test("ref-client.ts has no listAllConnectorSummaries/exhaustive fold — every caller must use one bounded page", async () => {
  const src = await readFile(REF_CLIENT_FILE, "utf8");
  assert.doesNotMatch(
    src,
    LIST_ALL_CONNECTOR_SUMMARIES_RE,
    "listAllConnectorSummaries was removed after the second gate REVISE (2026-07-29) — no render path may reintroduce an exhaustive fetch-every-page primitive"
  );
  assert.doesNotMatch(
    src,
    EXHAUSTIVE_FOLD_RE,
    "the page-following fold was deleted; only loadConnectorSummaryPage (one bounded page) may exist"
  );
});

// ---- third gate REVISE (2026-07-29), finding 1: the exact /_ref/connections seam ----

test("listConnectionsByConnector calls the UNPAGINATED /_ref/connections?connector_id= route — no limit/cursor param exists to construct a page", async () => {
  const src = await readFile(REF_CLIENT_FILE, "utf8");
  const body = functionBody(
    src,
    "export async function listConnectionsByConnector(",
    "export async function getFleetHealthVerdict("
  );
  assert.match(body, CONNECTIONS_SEAM_CALL_RE);
  // There is no `limit`/`cursor` param anywhere in this function's body —
  // this closes the "arriving on a later GLOBAL final page" ambiguity the
  // gate found in the rejected fleet-page stopgap: a call scoped by
  // connector_id has no page concept to land on, complete or otherwise.
  assert.doesNotMatch(body, NO_LIMIT_PARAM_RE);
  assert.doesNotMatch(body, NO_CURSOR_PARAM_RE);
});

test("route invariant: no production console file calls listConnectorSummaries() bare/unscoped", async () => {
  // Every first-party caller must either scope to one connection
  // (`{ connectionRouteId }`) or fetch one bounded page via
  // `loadConnectorSummaryPage`. A bare `listConnectorSummaries()` call
  // reintroduces the unbounded fan-out this migration removes from every
  // production call site. Test fixtures are excluded: they legitimately
  // reference the fake data-source method name (`notStubbed("listConnectorSummaries")`),
  // which is not a real call against `/_ref/connectors`.
  const files = (await walk(CONSOLE_DASHBOARD_DIR)).filter(
    (file) => file !== SELF && !file.endsWith("ref-client.ts") && !TEST_FILE_RE.test(file)
  );
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const offenders = files.filter((_file, index) => BARE_UNSCOPED_CALL_RE.test(sources[index] as string));
  assert.deepEqual(
    offenders,
    [],
    `no production console file may call the bare unscoped listConnectorSummaries(). Offenders:\n${offenders.join("\n")}`
  );
});
