/**
 * Falsifiability tests for the operation-boundary helper.
 *
 * The generalized boundary gate (operations-boundary.test.js) only proves
 * that current operation modules pass. These tests pin the matcher itself:
 * if a future refactor weakens `assertOperationBoundary`, these unit-style
 * tests SHALL fail, so the gate cannot become a green-path wrapper.
 *
 * Covers all standard ES static-import shapes that resolve a module
 * specifier at parse time:
 *   - bare side-effect: `import "fastify";`
 *   - default:          `import x from "fastify";`
 *   - namespace:        `import * as x from "fastify";`
 *   - named:            `import { x } from "fastify";`
 *   - type-only:        `import type { X } from "fastify";`
 *   - re-export named:  `export { x } from "fastify";`
 *   - re-export star:   `export * from "fastify";`
 * And asserts the intentional out-of-scope:
 *   - dynamic:          `await import("fastify");` SHALL NOT trip the gate
 *
 * Spec: openspec/changes/add-reference-operation-boundary-gate/
 *       specs/reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { assertOperationBoundary } from './helpers/operation-boundary.js';

function expectViolation(source, needle) {
  let thrown = null;
  try {
    assertOperationBoundary(source, 'fixture');
  } catch (err) {
    thrown = err;
  }
  assert.ok(
    thrown,
    `expected boundary violation for source containing "${needle}", got pass`,
  );
  assert.match(
    String(thrown.message),
    new RegExp(`must not import "${needle.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"`),
    `expected error message to name needle "${needle}", got: ${thrown.message}`,
  );
}

function expectClean(source) {
  assert.doesNotThrow(() => assertOperationBoundary(source, 'fixture'));
}

test('bare side-effect import of a forbidden module fails the gate', () => {
  expectViolation(`import "fastify";\n`, 'fastify');
  expectViolation(`import 'fastify';\n`, 'fastify');
});

test('default import of a forbidden module fails the gate', () => {
  expectViolation(`import x from "fastify";\n`, 'fastify');
});

test('namespace import of a forbidden module fails the gate', () => {
  expectViolation(`import * as x from "fastify";\n`, 'fastify');
});

test('named import of a forbidden module fails the gate', () => {
  expectViolation(`import { FastifyInstance } from "fastify";\n`, 'fastify');
});

test('type-only import of a forbidden module fails the gate', () => {
  expectViolation(`import type { FastifyInstance } from "fastify";\n`, 'fastify');
  expectViolation(`import type FastifyInstance from "fastify";\n`, 'fastify');
});

test('re-export from a forbidden module fails the gate', () => {
  expectViolation(`export { FastifyInstance } from "fastify";\n`, 'fastify');
  expectViolation(`export * from "fastify";\n`, 'fastify');
});

test('forbidden relative server modules fail the gate', () => {
  expectViolation(`import "../server/db";\n`, '../server/db');
  expectViolation(`import { x } from "../server/index";\n`, '../server/index');
  expectViolation(`import "./db";\n`, './db');
});

test('forbidden sandbox/demo specifier prefixes fail the gate', () => {
  // The needles are matched as specifier prefixes, mirroring how the prior
  // per-operation checks worked. A relative path that traverses *through*
  // these directories (e.g., `../../apps/web/...`) is not matched here;
  // those are caught by the relative-path entries (../server/index, etc.)
  // and by the no-cross-boundary review.
  expectViolation(`import "apps/web/foo";\n`, 'apps/web');
  expectViolation(`import { x } from "_demo/dataset";\n`, '_demo/');
});

test('static imports from the Node process module fail the gate', () => {
  // Closes the indirection around `process.env`: an operation could otherwise
  // bypass the env-access rule via `import { env } from "node:process"`
  // or `import process from "process"` without the source ever spelling
  // `process.env`. Both bare and `node:` specifiers are forbidden, in every
  // standard static-import shape.
  expectViolation(`import { env } from "node:process";\n`, 'node:process');
  expectViolation(`import process from "node:process";\n`, 'node:process');
  expectViolation(`import "node:process";\n`, 'node:process');
  expectViolation(`import { env } from "process";\n`, 'process');
  expectViolation(`import process from "process";\n`, 'process');
  expectViolation(`import "process";\n`, 'process');
});

test('process.env access outside comments fails the gate with a process.env-specific message', () => {
  let thrown = null;
  try {
    assertOperationBoundary('const x = process.env.FOO;\n', 'fixture');
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'process.env access must throw');
  assert.match(
    String(thrown.message),
    /must not read process\.env/,
    `expected process.env-specific message, got: ${thrown.message}`,
  );
});

test('process.env mentioned only inside comments does not trip the gate', () => {
  expectClean(
    `/**\n * This module SHALL NOT read process.env.\n */\nexport const x = 1;\n`,
  );
  expectClean(`// process.env is forbidden here\nexport const x = 1;\n`);
});

test('dynamic import is intentionally out of scope and does not trip the gate', () => {
  // Documented trade-off: only static specifiers are gated. Dynamic imports
  // remain a separate review concern; a future change may widen the rule.
  expectClean(`export async function load() { return import("fastify"); }\n`);
});

test('module mention in prose without import shape does not trip the gate', () => {
  // The string "fastify" alone is not an import. Module-header prose like
  // "this module SHALL NOT import Fastify" must not false-positive.
  expectClean(
    `/**\n * This module SHALL NOT import Fastify or Express.\n * It does not depend on better-sqlite3 either.\n */\nexport const x = 1;\n`,
  );
  expectClean(`export const note = "fastify is forbidden";\n`);
});
