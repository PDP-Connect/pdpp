// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Grep guard: overview-hero must not contain URL-shaped connector IDs or
 * legacy display logic. connector_id is always a canonical key post-migration.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = `${HERE}overview-hero.tsx`;

test("overview-hero does not contain registry.pdpp.org URL patterns", async () => {
  const src = await readFile(SRC, "utf8");
  assert.ok(
    !src.includes("registry.pdpp.org"),
    "connector_id is canonical post-migration; registry URL must not appear in display code"
  );
});

test("overview-hero does not contain URL-parsing logic for connector_id display", async () => {
  const src = await readFile(SRC, "utf8");
  assert.ok(!src.includes("new URL(connectorId)"), "canonical connector_id requires no URL parsing for display");
});

test("overview-hero does not contain local-device prefix stripping", async () => {
  const src = await readFile(SRC, "utf8");
  assert.ok(
    !src.includes("local-device:"),
    "connector_id is always canonical; local-device prefix must not appear in display code"
  );
});

test("empty overview points operators to source setup, not grant setup", async () => {
  const src = await readFile(SRC, "utf8");
  assert.ok(src.includes("addSourceHref"), "empty overview must accept an add-source target");
  assert.ok(src.includes("Add a data source"), "empty overview must name source setup");
  assert.ok(src.includes("Add a data source →"), "empty overview must render an add-source CTA");
  assert.ok(!src.includes("Start a grant to begin ingesting"), "grant setup must not be the ingestion CTA");
});
