// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

interface Manifest {
  streams: Array<{ coverage_strategy?: string; name: string }>;
}

const manifest = JSON.parse(readFileSync(new URL("../../manifests/ynab.json", import.meta.url), "utf8")) as Manifest;

test("YNAB delta streams preserve checkpoint-window coverage", () => {
  for (const name of ["category_groups", "categories", "payees", "transactions", "months", "month_categories"]) {
    const stream = manifest.streams.find((candidate) => candidate.name === name);
    assert.ok(stream, `${name} must remain declared`);
    assert.equal(stream.coverage_strategy, "checkpoint_window", `${name} remains incremental`);
  }
});

test("YNAB scheduled transactions retains its existing full-inventory strategy", () => {
  const stream = manifest.streams.find((candidate) => candidate.name === "scheduled_transactions");
  assert.ok(stream);
  assert.equal(stream.coverage_strategy, "full_inventory");
});
