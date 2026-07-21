#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  checkRepository,
  findLegacyConnectorRowImports,
  scanActiveOwnerSurface,
} from "./check-console-health-surfaces.mjs";

const ACTIVE = "apps/console/src/app/(console)/sources/sources-view-model.ts";

test("active owner-surface scan catches raw state and legacy next-action fallbacks", () => {
  const findings = scanActiveOwnerSurface(
    ACTIVE,
    `const status = health.state; const next = formatNextAction(summary.next_action);`
  );
  assert.deepEqual(
    findings.map((f) => f.ruleId),
    ["raw-health-state", "legacy-next-action"]
  );
});

test("active owner-surface scan catches mechanistic detail fields", () => {
  const findings = scanActiveOwnerSurface(
    "apps/console/src/app/(console)/sources/sources-view.tsx",
    `return <span>{detail_gap_backlog?.pending} {connectionHealth.collection_rate}</span>;`
  );
  assert.deepEqual(
    findings.map((f) => f.ruleId),
    ["inspection-field-on-dashboard"]
  );
});

test("diagnostics and tests are outside the owner attention scan", () => {
  const diagnostics = scanActiveOwnerSurface(
    "apps/console/src/app/(console)/sources/[connector]/connection-diagnostics.tsx",
    `const state = connectionHealth.state; const retry = connectionHealth.next_attempt_at;`
  );
  assert.deepEqual(diagnostics, []);
});

test("legacy connector row cannot be reactivated by a new owner surface import", () => {
  const findings = findLegacyConnectorRowImports(
    new Map([
      ["apps/console/src/app/(console)/sources/connector-row.tsx", "export function ConnectorRow() {}"],
      ["apps/console/src/app/(console)/sources/page.tsx", `import { ConnectorRow } from "./connector-row.tsx";`],
    ])
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, "legacy-connector-row-reactivated");
});

test("current repository owner surfaces pass the rendered-verdict gate", () => {
  assert.deepEqual(checkRepository(), []);
});
