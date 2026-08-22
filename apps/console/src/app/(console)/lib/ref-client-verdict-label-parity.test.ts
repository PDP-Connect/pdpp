// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner ledger 2026-08-22, item flagged by the quiet-setup-expiry lane:
 * `RefVerdictPill.label` in `ref-client.ts` is a hand-maintained mirror of
 * the reference server's `VerdictLabel` union (`runtime/rendered-verdict.ts`)
 * — the console app cannot import server runtime code directly (see
 * ref-client-pagination.test.ts's header for why `ref-client.ts` cannot be
 * imported by node:test either). The server legitimately emits "Archived"
 * (`ref-control.ts:6619`) and "Setup never completed" (`ref-control.ts:6629`)
 * pills, but the console mirror's union omitted both, which would make a
 * strictly-typed caller narrow those two real server values to nothing.
 *
 * This test pins the mirror at the source-text level so the two unions
 * cannot silently re-diverge, matching ref-client-pagination.test.ts's
 * established source-scanning pattern for this same file.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REF_CLIENT_FILE = `${HERE}ref-client.ts`;

const REQUIRED_PILL_LABELS = [
  "Archived",
  "Can't collect",
  "Checking",
  "Healthy",
  "Import complete",
  "Missing data",
  "Needs refresh",
  "Not measured",
  "Setup never completed",
  "Syncing",
];

test("RefVerdictPill.label carries every terminal label the reference server emits", async () => {
  const source = await readFile(REF_CLIENT_FILE, "utf8");
  const interfaceMatch = source.match(/export interface RefVerdictPill \{[\s\S]*?\n\}/);
  assert.ok(interfaceMatch, "RefVerdictPill interface must exist in ref-client.ts");
  const interfaceBody = interfaceMatch[0];
  for (const label of REQUIRED_PILL_LABELS) {
    assert.ok(
      interfaceBody.includes(`"${label}"`),
      `RefVerdictPill.label is missing "${label}", which the reference server emits (ref-control.ts). ` +
        "A caller that switches on this union would silently fail to narrow a real server value."
    );
  }
});
