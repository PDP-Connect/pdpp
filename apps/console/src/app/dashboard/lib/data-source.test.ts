/**
 * Guard tests for the live `/dashboard/**` boundary.
 *
 * These tests are static: they walk the `/dashboard/**` source tree and
 * fail if any file imports from `/sandbox/**`. The point is the same
 * invariant the corrective tranche calls out:
 *   - `/dashboard/**` must never silently fall back to sandbox data.
 *   - The sandbox data source must never be reachable through the live
 *     dashboard's owner-token path.
 *
 * They also assert the live data source identifies as `live` and binds
 * to the existing rs/ref clients (i.e. that the seam wraps real
 * functions, not stubs).
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// NOTE: We deliberately do NOT import `liveDashboardDataSource` here.
// It transitively imports `owner-token.ts` which depends on
// `server-only`, which throws when loaded outside a server-component
// context. Static analysis is sufficient for the boundary invariants
// this file is asserting.

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const DASHBOARD_DIR = join(HERE, "..");
const DATA_SOURCE_PATH = join(HERE, "data-source.ts");

const TS_FILE_RE = /\.(ts|tsx)$/;
const LIVE_KIND_RE = /kind:\s*"live"/;
const SANDBOX_FROM_IMPORT_RE = /\bfrom\s+["'][^"']*\/sandbox(?:\/|["'])/m;
const SANDBOX_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["'][^"']*\/sandbox(?:\/|["'])/m;
const VERIFY_DASHBOARD_SESSION_RE = /verifyDashboardSession/;
const VERIFY_DASHBOARD_SESSION_CALL_RE = /verifyDashboardSession\s*\(/g;
const OWNER_LOGIN_REDIRECT_RE = /redirectToOwnerLogin/;
const DASHBOARD_RETURN_TO_LOGIN_RE = /owner\/login\?return_to=%2Fdashboard/;

async function walk(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files);
    } else if (TS_FILE_RE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test("live data source declares kind: 'live' in source", async () => {
  const src = await readFile(DATA_SOURCE_PATH, "utf8");
  assert.match(src, LIVE_KIND_RE);
});

test("live data source binds every DashboardDataSource method", async () => {
  const src = await readFile(DATA_SOURCE_PATH, "utf8");
  for (const name of [
    "listConnectorSummaries",
    "listConnectorManifests",
    "listStreams",
    "getStreamMetadata",
    "getConnectorOverview",
    "queryRecords",
    "getRecord",
    "refSearch",
    "searchRecordsLexical",
    "searchRecordsSemantic",
    "searchRecordsHybrid",
    "isSemanticRetrievalAdvertised",
    "isHybridRetrievalAdvertised",
    "listGrants",
    "listRuns",
    "listTraces",
    "getGrantTimeline",
    "getRunTimeline",
    "getTraceTimeline",
    "getDatasetSummary",
    "listPendingApprovals",
    "getDeploymentDiagnostics",
  ]) {
    assert.ok(src.includes(name), `live data source binding missing method: ${name}`);
  }
});

function stripComments(src: string): string {
  // Drop comments but keep string literal contents. Import paths live inside
  // strings, so stripping strings would make the guard a false negative.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function hasSandboxImport(src: string): boolean {
  const withoutComments = stripComments(src);
  return SANDBOX_FROM_IMPORT_RE.test(withoutComments) || SANDBOX_DYNAMIC_IMPORT_RE.test(withoutComments);
}

test("sandbox import detector catches static and dynamic imports", () => {
  assert.equal(hasSandboxImport('import { x } from "@/app/sandbox/_demo/data-source.ts";'), true);
  assert.equal(hasSandboxImport('export { x } from "../../sandbox/_demo/data-source.ts";'), true);
  assert.equal(hasSandboxImport('const x = await import("../sandbox/_demo/data-source.ts");'), true);
  assert.equal(hasSandboxImport('// import { x } from "@/app/sandbox/_demo/data-source.ts";'), false);
  assert.equal(hasSandboxImport('const label = "sandbox";'), false);
});

test("/dashboard/** never imports from /sandbox/**", async () => {
  const files = await walk(DASHBOARD_DIR);
  const offenders: string[] = [];
  for (const file of files) {
    if (file === SELF) {
      continue;
    }
    const src = await readFile(file, "utf8");
    // Match Next/TS import statements that resolve to the sandbox tree:
    //   import ... from "@/app/sandbox/..."
    //   import ... from "../../sandbox/..."
    //   import ... from "../sandbox/..."
    if (hasSandboxImport(src)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `dashboard files must not import from /sandbox/**. Offenders:\n${offenders.join("\n")}`
  );
});

test("ref-client and rs-client gate every fetch through verifyDashboardSession", async () => {
  // Architectural invariant: the dashboard's two fetch wrappers
  // (refFetch in ref-client.ts; authedFetch + the three search functions in
  // rs-client.ts) MUST call `verifyDashboardSession` before issuing the
  // network request. This is the DAL boundary per Next.js 16 official
  // guidance and survives a CVE-2025-29927-style middleware bypass. If
  // someone adds a new fetch wrapper, this test fails until they wire the
  // DAL gate.
  const refClient = await readFile(join(HERE, "ref-client.ts"), "utf8");
  const rsClient = await readFile(join(HERE, "rs-client.ts"), "utf8");

  // Both files must import the helper.
  assert.match(refClient, VERIFY_DASHBOARD_SESSION_RE);
  assert.match(rsClient, VERIFY_DASHBOARD_SESSION_RE);

  // Every body that issues a `fetch(...)` against the AS or RS internal URLs
  // must call verifyDashboardSession before that fetch. We check this by
  // counting fetch call sites and verify-session call sites; the latter
  // must be at least equal to the former for the request-issuing sites.
  function fetchSitesAgainstInternalUrl(src: string, urlGetter: string): number {
    // Match `fetch(<expr containing urlGetter>` constructs (one per call site).
    const re = new RegExp(`\\bfetch\\([^)]*${urlGetter}\\b`, "g");
    return (src.match(re) ?? []).length;
  }
  function verifyCalls(src: string): number {
    return (src.match(VERIFY_DASHBOARD_SESSION_CALL_RE) ?? []).length;
  }

  const refFetchSites = fetchSitesAgainstInternalUrl(refClient, "getAsInternalUrl");
  const rsFetchSites = fetchSitesAgainstInternalUrl(rsClient, "getRsInternalUrl");
  const refVerifyCalls = verifyCalls(refClient);
  const rsVerifyCalls = verifyCalls(rsClient);

  assert.ok(
    refVerifyCalls >= refFetchSites,
    `ref-client.ts has ${refFetchSites} AS-internal fetch sites but only ${refVerifyCalls} verifyDashboardSession calls — every AS read must be DAL-gated.`
  );
  assert.ok(
    rsVerifyCalls >= rsFetchSites,
    `rs-client.ts has ${rsFetchSites} RS-internal fetch sites but only ${rsVerifyCalls} verifyDashboardSession calls — every RS read must be DAL-gated.`
  );
});

test("dashboard owner-session 401s resolve back through owner login", async () => {
  const refClient = await readFile(join(HERE, "ref-client.ts"), "utf8");
  const ownerToken = await readFile(join(HERE, "owner-token.ts"), "utf8");
  const dashboardError = await readFile(join(HERE, "..", "error.tsx"), "utf8");

  assert.match(refClient, OWNER_LOGIN_REDIRECT_RE);
  assert.match(ownerToken, OWNER_LOGIN_REDIRECT_RE);
  assert.match(dashboardError, DASHBOARD_RETURN_TO_LOGIN_RE);
});

test("/dashboard/** never references the sandbox data source binding", async () => {
  const files = await walk(DASHBOARD_DIR);
  const offenders: string[] = [];
  for (const file of files) {
    if (file === SELF) {
      continue;
    }
    const src = stripComments(await readFile(file, "utf8"));
    if (src.includes("sandboxDashboardDataSource")) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `dashboard files must not reference sandboxDashboardDataSource. Offenders:\n${offenders.join("\n")}`
  );
});
