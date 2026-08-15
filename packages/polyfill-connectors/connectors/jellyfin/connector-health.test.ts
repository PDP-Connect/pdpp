// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { itemRecord, JELLYFIN_RETRYABLE_PATTERN } from "./index.ts";
import { itemsSchema } from "./schemas.ts";

const item = JSON.parse(
  readFileSync(new URL("./__fixtures__/item-missing-user-data.json", import.meta.url), "utf8")
) as Record<string, unknown>;

test("Jellyfin item records preserve unavailable playback state as null", () => {
  const record = itemRecord(item, "fixture-library");
  assert.equal(record.play_count, null);
  assert.equal(record.played, null);
  assert.equal(itemsSchema.safeParse(record).success, true);
});

test("Jellyfin retry classification preserves provider throttles and exhausted transient HTTP errors", () => {
  assert.equal(JELLYFIN_RETRYABLE_PATTERN.test("jellyfin_rate_limited"), true);
  assert.equal(JELLYFIN_RETRYABLE_PATTERN.test("jellyfin_http_503: retryable status 503"), true);
  assert.equal(JELLYFIN_RETRYABLE_PATTERN.test("fetch failed"), true);
  assert.equal(JELLYFIN_RETRYABLE_PATTERN.test("jellyfin_auth_failed"), false);
});
