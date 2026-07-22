// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Grep guard: search-record-timestamps must not contain URL-shaped fallback
 * logic. connector_id metadata is always keyed by canonical connector key.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = `${HERE}search-record-timestamps.ts`;

test("search-record-timestamps does not contain registry URL suffix fallback", async () => {
  const src = await readFile(SRC, "utf8");
  assert.ok(
    !src.includes("registrySuffix"),
    "URL-suffix fallback removed; metadata is keyed by canonical connector key"
  );
});

test("search-record-timestamps does not contain local-device prefix parsing", async () => {
  const src = await readFile(SRC, "utf8");
  assert.ok(!src.includes("local-device:"), "connector_id is canonical; local-device prefix parsing must not appear");
});
