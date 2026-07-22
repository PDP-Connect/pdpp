// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Static guard tests for sandbox route operation parity.
 *
 * These checks intentionally do not import route handlers. They protect the
 * source boundary while sandbox routes are being migrated incrementally:
 * operation-backed routes must stay mounted on canonical operation modules,
 * sandbox routes must not call live AS/RS clients or live data sources, and
 * `_demo/builders.ts` may only construct responses for the explicitly
 * allowlisted temporary routes whose canonical operations are not mounted yet.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SANDBOX_DIR = join(HERE, "..");

const ROUTE_FILE = "route.ts";
const OPERATIONS_IMPORT_RE = /from\s+["']pdpp-reference-implementation\/operations\/([^"']+)["']/g;
const BUILDERS_IMPORT_RE = /from\s+["'][^"']*_demo\/builders\.ts["']/;

const LIVE_ROUTE_IMPORT_PATTERNS = [
  {
    name: "dashboard ref client",
    re: /from\s+["'][^"']*\/dashboard\/lib\/ref-client(?:\.ts)?["']/,
  },
  {
    name: "dashboard rs client",
    re: /from\s+["'][^"']*\/dashboard\/lib\/rs-client(?:\.ts)?["']/,
  },
  {
    name: "live dashboard data source",
    re: /from\s+["'][^"']*\/dashboard\/lib\/data-source(?:\.ts)?["']|liveDashboardDataSource/,
  },
  {
    name: "reference server live data source",
    re: /from\s+["']pdpp-reference-implementation\/server\/[^"']+["']/,
  },
];

const EXPECTED_OPERATION_MODULES = new Set([
  "as-authorization-server-metadata",
  "ref-dataset-summary",
  "ref-spine-correlations-list",
  "ref-spine-events-page",
  "rs-protected-resource-metadata",
  "rs-records-detail",
  "rs-records-list",
  "rs-schema-get",
  "rs-search-lexical",
  "rs-streams-detail",
  "rs-streams-list",
]);

/**
 * Temporary exceptions for routes whose canonical operations are not mounted
 * yet. Remove entries here as each route migrates from `_demo/builders.ts` to
 * a reference operation.
 */
const TEMPORARY_BUILDER_ROUTE_ALLOWLIST = new Set<string>([]);

interface RouteSource {
  operations: string[];
  rel: string;
  src: string;
}

async function collectRouteSources(dir = SANDBOX_DIR): Promise<RouteSource[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const routes: RouteSource[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      routes.push(...(await collectRouteSources(full)));
      continue;
    }
    if (entry.name !== ROUTE_FILE) {
      continue;
    }
    const src = await readFile(full, "utf8");
    routes.push({
      operations: [...src.matchAll(OPERATIONS_IMPORT_RE)]
        .map((match) => match[1])
        .filter((operation): operation is string => typeof operation === "string"),
      rel: relative(SANDBOX_DIR, full).split(sep).join("/"),
      src,
    });
  }
  return routes.sort((a, b) => a.rel.localeCompare(b.rel));
}

test("sandbox route handlers do not import live AS/RS clients or live data sources", async () => {
  const offenders: string[] = [];
  for (const route of await collectRouteSources()) {
    for (const pattern of LIVE_ROUTE_IMPORT_PATTERNS) {
      if (pattern.re.test(route.src)) {
        offenders.push(`${route.rel}: ${pattern.name}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `sandbox route handlers must stay on sandbox fixtures, not live clients/data sources:\n${offenders.join("\n")}`
  );
});

test("known canonical sandbox operations stay mounted on route handlers", async () => {
  const mounted = new Map<string, string[]>();
  for (const route of await collectRouteSources()) {
    for (const operation of route.operations) {
      mounted.set(operation, [...(mounted.get(operation) ?? []), route.rel]);
    }
  }

  const missing = [...EXPECTED_OPERATION_MODULES].filter((operation) => !mounted.has(operation));
  assert.deepEqual(missing, [], `expected sandbox routes to mount these canonical operations:\n${missing.join("\n")}`);
});

test("operation-backed sandbox routes do not use demo builders for business responses", async () => {
  const offenders = (await collectRouteSources())
    .filter((route) => route.operations.length > 0 && BUILDERS_IMPORT_RE.test(route.src))
    .map((route) => `${route.rel}: ${route.operations.join(", ")}`);

  assert.deepEqual(
    offenders,
    [],
    `operation-backed sandbox routes must not import _demo/builders.ts:\n${offenders.join("\n")}`
  );
});

test("demo builders are limited to temporary missing-operation sandbox routes", async () => {
  const builderRoutes = (await collectRouteSources())
    .filter((route) => BUILDERS_IMPORT_RE.test(route.src))
    .map((route) => route.rel);
  const unexpected = builderRoutes.filter((route) => !TEMPORARY_BUILDER_ROUTE_ALLOWLIST.has(route));
  const staleAllowlist = [...TEMPORARY_BUILDER_ROUTE_ALLOWLIST].filter((route) => !builderRoutes.includes(route));

  assert.deepEqual(
    unexpected,
    [],
    `only temporary missing-operation routes may import _demo/builders.ts:\n${unexpected.join("\n")}`
  );
  assert.deepEqual(
    staleAllowlist,
    [],
    `temporary builder allowlist contains migrated or deleted routes; remove these entries:\n${staleAllowlist.join("\n")}`
  );
});
