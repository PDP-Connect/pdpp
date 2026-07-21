#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import { readManifests, renderInventory } from "./stream-evidence-inventory.mjs";

function manifestRow(overrides = {}) {
  return {
    manifestSet: "polyfill",
    connectorId: "demo",
    manifest: {
      streams: [
        {
          name: "stream",
          coverage_strategy: "snapshot_import_receipt",
          freshness_strategy: "device_heartbeat",
          ...overrides,
        },
      ],
    },
  };
}

test("inventory gate treats required accepted-absence streams as developer debt", () => {
  const { requiredAcceptedAbsenceCount, missingStrategyCount } = renderInventory([
    manifestRow({ required: true, coverage_policy: "deferred" }),
  ]);

  assert.equal(missingStrategyCount, 0);
  assert.equal(requiredAcceptedAbsenceCount, 1);
});

test("inventory gate allows accepted-absence streams once they opt out of requiredness", () => {
  const { requiredAcceptedAbsenceCount, missingStrategyCount } = renderInventory([
    manifestRow({ required: false, coverage_policy: "inventory_only" }),
  ]);

  assert.equal(missingStrategyCount, 0);
  assert.equal(requiredAcceptedAbsenceCount, 0);
});

test("codex skills stays required because it is content-bearing", () => {
  const codex = readManifests().find(
    ({ manifestSet, connectorId }) => manifestSet === "polyfill" && connectorId === "codex"
  );

  assert.ok(codex);

  const skills = codex.manifest.streams.find((stream) => stream.name === "skills");
  assert.ok(skills);
  assert.equal(skills.required ?? true, true);
  assert.equal(skills.coverage_policy, undefined);
});

test("shipped manifests contain no required accepted-absence streams", () => {
  const { requiredAcceptedAbsenceCount, missingStrategyCount } = renderInventory(readManifests());

  assert.equal(missingStrategyCount, 0);
  assert.equal(requiredAcceptedAbsenceCount, 0);
});
