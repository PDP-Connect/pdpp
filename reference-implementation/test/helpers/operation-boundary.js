/**
 * Shared boundary rule for canonical reference operations.
 *
 * Every operation module at `reference-implementation/operations/<name>/index.ts`
 * SHALL NOT statically import Fastify, Express, Next, SQLite, Postgres, a raw
 * SQL handle, a generic repository, sandbox UI/page code, `_demo/` builders, or
 * the Node `process` module (`node:process` / `process`), and SHALL NOT contain
 * executable `process.env` access. The Node-process import ban closes the
 * indirection gap (`import { env } from "node:process"` /
 * `import process from "process"`) that would otherwise let the
 * env-access rule be bypassed without the source ever spelling `process.env`.
 *
 * The check is grep-style on source: it does not execute the modules. Trade-off:
 * it cannot catch dynamically-resolved imports (`require()`, `await import()`,
 * string concatenation), but it does catch the static-import drift class this
 * gate is meant to prevent.
 *
 * Forbidden static imports are matched in two shapes so bare side-effect
 * imports cannot bypass the gate:
 *   1. `from '<needle>'` / `from "<needle>"` — covers
 *      `import x from`, `import type { X } from`, `import * as x from`,
 *      `import { x } from`, `export { x } from`, `export * from`.
 *   2. `import '<needle>'` / `import "<needle>"` — covers bare
 *      side-effect imports such as `import "fastify";`.
 * The regex requires whitespace or quote immediately after `import`/`from`,
 * so `import("…")` (dynamic) does not match here — dynamic imports remain an
 * intentional out-of-scope trade-off.
 *
 * Comments are stripped before the `process.env` check so module headers can
 * name the rule without tripping the guard. The import check runs against the
 * raw source: forbidden-import strings only match a literal import/from
 * specifier shape, which is unlikely to appear in prose.
 *
 * Spec: openspec/changes/add-reference-operation-boundary-gate/
 *       specs/reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

function escapeForRegex(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Single source of truth for forbidden static imports in operation modules.
 * Adding a new entry here covers every current and future operation.
 */
export const forbiddenOperationImports = Object.freeze([
  // HTTP frameworks.
  'fastify',
  'express',
  'next/',
  // Concrete database drivers.
  'better-sqlite3',
  'pg',
  // Server-internal raw DB / repository / route modules.
  './db',
  '../db',
  '../lib/db',
  '../server/db',
  '../server/records',
  '../server/auth',
  '../server/index',
  // Sandbox UI/page code and fixture builders.
  'apps/web',
  '_demo/',
  // Node process module — covers the indirection paths around
  // `process.env`. Both the bare and `node:` specifiers are forbidden so
  // `import { env } from "node:process"` and
  // `import process from "process"` cannot bypass the env-access rule.
  'node:process',
  'process',
]);

/**
 * Discover canonical operation modules.
 *
 * Returns absolute paths to `<repoRoot>/reference-implementation/operations/<name>/index.ts`
 * for every subdirectory of `operations/` that contains an `index.ts`.
 * Subdirectories without `index.ts` are intentionally skipped — there is no
 * operation to gate.
 *
 * @param {string} repoRoot - Absolute path to the repo root.
 * @returns {{ name: string, absPath: string, relPath: string }[]}
 */
export function discoverOperationModules(repoRoot) {
  const operationsDir = path.join(
    repoRoot,
    'reference-implementation',
    'operations',
  );

  let entries;
  try {
    entries = readdirSync(operationsDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const modules = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const indexAbs = path.join(operationsDir, entry.name, 'index.ts');
    let stats;
    try {
      stats = statSync(indexAbs);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    if (!stats.isFile()) continue;
    modules.push({
      name: entry.name,
      absPath: indexAbs,
      relPath: path.relative(repoRoot, indexAbs),
    });
  }

  return modules.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Assert that `source` obeys the operation-module boundary rule.
 *
 * @param {string} source - Source text of the operation module.
 * @param {string} label - Human-readable identifier for failure messages
 *   (typically the relative path of the module).
 */
export function assertOperationBoundary(source, label) {
  for (const needle of forbiddenOperationImports) {
    const escaped = escapeForRegex(needle);
    // `from '<needle>'` / `from "<needle>"` — `import x from`, `import type … from`,
    // `import * as … from`, `import { … } from`, `export { … } from`, `export * from`.
    const fromPattern = new RegExp(`\\bfrom\\s*['"]${escaped}`);
    // `import '<needle>'` / `import "<needle>"` — bare side-effect imports.
    // Requires whitespace or quote immediately after `import` so dynamic
    // `import("…")` is excluded (intentional: dynamic imports are out of scope).
    const bareImportPattern = new RegExp(`\\bimport\\s+['"]${escaped}`);

    const matched = fromPattern.test(source) || bareImportPattern.test(source);
    assert.equal(
      matched,
      false,
      `${label}: operation module must not import "${needle}"`,
    );
  }

  // process.env access is also forbidden. Strip comments first so module
  // headers that document the rule do not trip the guard.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.equal(
    stripped.includes('process.env'),
    false,
    `${label}: operation module must not read process.env`,
  );
}

/**
 * Convenience: read an operation module from disk and assert the rule.
 *
 * @param {string} absPath
 * @param {string} label
 */
export function assertOperationBoundaryAtPath(absPath, label) {
  const source = readFileSync(absPath, 'utf8');
  assertOperationBoundary(source, label);
}
