// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Disclosure spine conformance — in-memory second adapter.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/disclosure-spine-conformance.js` against the conforming in-memory
 * driver. This is the storage-only proof for `add-second-conformance-adapters`
 * task 3.1: the same harness that pins the SQLite reference's spine semantics
 * also passes against an independent adapter that does not share storage,
 * cursor encoding, or summary aggregation code with SQLite.
 *
 * Together with the SQLite reference run and the falsifiability run, this
 * suite shows the harness encodes durable semantic obligations rather than
 * `spine_events` SQL shape.
 *
 * Spec: openspec/changes/add-second-conformance-adapters/design.md § Lane 3.
 */

import test from 'node:test';

import { runDisclosureSpineConformance } from './helpers/disclosure-spine-conformance.js';
import { createMemoryDisclosureSpineDriver } from './helpers/memory-disclosure-spine-driver.js';

runDisclosureSpineConformance({
  label: 'memory',
  test,
  makeDriver: () => createMemoryDisclosureSpineDriver(),
});
