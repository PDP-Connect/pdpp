// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The source detail page must lead with what the owner came for.
 *
 * Owner, 2026-08-07: "There is no information architecture. Diagnostics is open
 * by default and is the first thing you see. […] Streams and Runs/Syncs are the
 * main things a user expects to see."
 *
 * Diagnostics is operator-debug detail — condition rows, evidence, recovery
 * commands. It rendered above the streams and runs the page exists to show, so
 * the page opened with its least-wanted content. This pins the corrected order.
 *
 * Deliberately NOT pinned: the visual design of these sections. The owner is
 * bringing in a designer; this guard is about sequence only, so a redesign that
 * keeps the order does not fight this test.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIAGNOSTICS_CLOSED_BY_DEFAULT_RE = /open=\{hasDeviceLocalRemediation \|\| undefined\}/;
const PAGE_FILE = `${HERE}page.tsx`;

interface SectionOffsets {
  configuration: number;
  coverage: number;
  dangerZone: number;
  diagnostics: number;
  runs: number;
}

async function renderOrder(): Promise<SectionOffsets> {
  const src = await readFile(PAGE_FILE, "utf8");
  return {
    configuration: src.indexOf("<ConnectionConfiguration"),
    coverage: src.indexOf("<AcquisitionCoverageSection"),
    dangerZone: src.indexOf("<ConnectionDangerZone"),
    diagnostics: src.indexOf("<ConnectionDiagnostics"),
    runs: src.indexOf("<RecentRunsSection"),
  };
}

test("streams and runs render before diagnostics", async () => {
  const at = await renderOrder();
  for (const [name, index] of Object.entries(at)) {
    assert.notEqual(index, -1, `${name} must render on this page`);
  }
  assert.ok(at.coverage < at.diagnostics, "acquisition coverage precedes diagnostics");
  assert.ok(at.runs < at.diagnostics, "recent runs precede diagnostics");
});

test("the danger zone stays last", async () => {
  const at = await renderOrder();
  assert.ok(at.diagnostics < at.dangerZone, "destructive actions remain the final section");
});

/**
 * Configuration is owner-decision content, not operator-debug detail. It
 * belongs with the streams and runs an owner opens this page for — after them,
 * because it is a deliberate act rather than a status read, and before
 * diagnostics for the same reason diagnostics moved below runs. It is not
 * destructive, so it stays above the danger zone.
 */
test("configuration sits after runs and before diagnostics and the danger zone", async () => {
  const at = await renderOrder();
  assert.notEqual(at.configuration, -1, "configuration must render on this page");
  assert.ok(at.runs < at.configuration, "recent runs precede configuration");
  assert.ok(at.configuration < at.diagnostics, "configuration precedes operator diagnostics");
  assert.ok(at.configuration < at.dangerZone, "configuration precedes the danger zone");
});

test("diagnostics stays collapsed unless it has something actionable", async () => {
  // An <details> that is open by default reintroduces the original complaint
  // even if the section is ordered correctly. The one sanctioned exception is a
  // device-local remediation the owner must actually run.
  const src = await readFile(`${HERE}connection-diagnostics.tsx`, "utf8");
  assert.match(src, DIAGNOSTICS_CLOSED_BY_DEFAULT_RE);
});
