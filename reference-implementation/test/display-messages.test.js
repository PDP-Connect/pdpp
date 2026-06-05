import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { DISPLAY_MESSAGES, displayMessageFor } from '../runtime/display-messages.ts';

// ─── Module-shape sanity ───────────────────────────────────────────────────

test('displayMessageFor returns null for null/empty input', () => {
  assert.equal(displayMessageFor(null), null);
  assert.equal(displayMessageFor(''), null);
});

test('displayMessageFor returns the registry entry for a known code', () => {
  assert.equal(displayMessageFor('cloudflare_challenge'), DISPLAY_MESSAGES.cloudflare_challenge);
});

test('displayMessageFor returns null for an unregistered code (UI handles fallback)', () => {
  assert.equal(displayMessageFor('definitely_not_a_real_reason_code'), null);
});

// ─── Registry-quality invariants ───────────────────────────────────────────

test('no registry value is an empty string', () => {
  for (const [key, value] of Object.entries(DISPLAY_MESSAGES)) {
    assert.notEqual(value, '', `DISPLAY_MESSAGES[${key}] is empty`);
    assert.equal(typeof value, 'string', `DISPLAY_MESSAGES[${key}] must be a string`);
  }
});

test('no bare reason-code-as-value entries (registry must translate, not parrot)', () => {
  for (const [key, value] of Object.entries(DISPLAY_MESSAGES)) {
    assert.notEqual(
      value,
      key,
      `DISPLAY_MESSAGES[${key}] is the same as its key — that just relocates the confusion. Write an end-user-vetted message.`
    );
  }
});

// ─── Registry completeness: every connector-emitted reason has a vetted message ─

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTORS_DIR = resolve(HERE, '../../packages/polyfill-connectors/connectors');

async function listConnectorDirs() {
  const entries = await readdir(CONNECTORS_DIR);
  const dirs = [];
  for (const name of entries) {
    const full = join(CONNECTORS_DIR, name);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      dirs.push(full);
    }
  }
  return dirs;
}

/**
 * Scan a single connector's `index.ts` (if present) for the reason codes it
 * emits. This catches the emission shapes the brief calls out:
 *   - SKIP_RESULT entries:   { type: "SKIP_RESULT", reason: "..." }
 *   - connector_error reasons embedded inline in run records.
 *   - terminal/decision objects: { kind: "terminal", reason: "..." }
 *
 * The scan reads the *value expression* of every `reason:` property and
 * collects every string literal in it. A direct literal (`reason: "x"`) and a
 * ternary (`reason: cond ? "a" : "b"`) both surface their codes — the ternary
 * form previously slipped past a literal-only regex, so codes like
 * `missing_mapping` were emitted live with no vetted display message and the
 * dashboard would have shown `null`. Reading the whole value expression closes
 * that blind spot without an allowlist.
 */
async function reasonsEmittedBy(connectorDir) {
  const indexPath = join(connectorDir, 'index.ts');
  let source;
  try {
    source = await readFile(indexPath, 'utf8');
  } catch {
    return [];
  }
  const reasons = new Set();
  // Capture the value expression of each `reason:` property: everything from
  // the colon up to the end of that line (connector emissions keep the reason
  // value on one line). Then pull every snake_case string literal out of it,
  // so both `reason: "x"` and `reason: cond ? "a" : "b"` are covered.
  const reasonValue = /\breason\s*:\s*([^\n]*)/g;
  const literal = /"([a-z][a-z0-9_]*)"/g;
  let match;
  while ((match = reasonValue.exec(source)) !== null) {
    let lit;
    literal.lastIndex = 0;
    while ((lit = literal.exec(match[1])) !== null) {
      if (lit[1] === 'reason' && /\[\s*["']reason["']\s*\]/.test(match[1])) {
        continue;
      }
      reasons.add(lit[1]);
    }
  }
  return [...reasons];
}

test('every connector-emitted reason code has a registered display message', async () => {
  const dirs = await listConnectorDirs();
  assert.ok(dirs.length > 0, 'expected at least one connector directory');

  const missing = [];
  for (const dir of dirs) {
    const reasons = await reasonsEmittedBy(dir);
    for (const reason of reasons) {
      if (!(reason in DISPLAY_MESSAGES)) {
        missing.push({ connector: dir.split('/').pop(), reason });
      }
    }
  }

  // If this assertion fires the right fix is to ADD the missing
  // reason code(s) to `runtime/display-messages.ts` with vetted
  // end-user copy — NOT to weaken this test. The whole point of the
  // registry is that the UI never sees a raw reason code.
  if (missing.length > 0) {
    const lines = missing.map(({ connector, reason }) => `  ${connector}: ${reason}`).join('\n');
    assert.fail(
      `Reason codes emitted by connectors but missing from DISPLAY_MESSAGES registry:\n${lines}\n\n` +
        'Add an entry to reference-implementation/runtime/display-messages.ts.'
    );
  }
});
