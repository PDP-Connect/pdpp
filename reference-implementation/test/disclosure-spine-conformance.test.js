/**
 * Disclosure spine conformance — SQLite reference driver.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/disclosure-spine-conformance.js` against the current SQLite-backed
 * reference spine helpers (`emitSpineEvent`, `listSpineEventsPage`,
 * `listSpineCorrelations`). Replaces nothing on its own; the focused
 * event-spine route-level suites remain as direct evidence alongside this
 * conformance run. See worker report for rationale.
 *
 * Spec: openspec/changes/add-disclosure-spine-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';

import { runDisclosureSpineConformance } from './helpers/disclosure-spine-conformance.js';
import { createSqliteDisclosureSpineDriver } from './helpers/sqlite-disclosure-spine-driver.js';

runDisclosureSpineConformance({
  label: 'sqlite-reference',
  test,
  makeDriver: () => createSqliteDisclosureSpineDriver(),
});
