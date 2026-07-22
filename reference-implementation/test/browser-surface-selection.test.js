// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { pickMostRecentCurrentSurface } from "../server/browser-surface-selection.ts";

function surface(overrides = {}) {
  return {
    surface_id: "surface_default",
    backend: "neko",
    profile_key: "chatgpt",
    connector_id: "chatgpt",
    cdp_url: "http://neko:9222",
    stream_base_url: "http://neko:8080",
    health: "ready",
    created_at: "2026-05-19T10:00:00.000Z",
    last_used_at: "2026-05-19T10:05:00.000Z",
    ...overrides,
  };
}

test("current surface picker returns the newest ready unleased surface over older unhealthy history", () => {
  const picked = pickMostRecentCurrentSurface([
    surface({
      surface_id: "surface_old_history",
      health: "unhealthy",
      created_at: "2026-05-19T09:00:00.000Z",
      last_used_at: "2026-05-19T09:05:00.000Z",
    }),
    surface({
      surface_id: "surface_current_ready",
      health: "ready",
      created_at: "2026-05-19T11:00:00.000Z",
      last_used_at: "2026-05-19T11:59:00.000Z",
    }),
  ]);

  assert.equal(picked?.surface_id, "surface_current_ready");
});

test("current surface picker ignores released unhealthy history when no current evidence remains", () => {
  const picked = pickMostRecentCurrentSurface([
    surface({
      surface_id: "surface_released_history",
      health: "unhealthy",
      active_lease_id: undefined,
      created_at: "2026-05-19T09:00:00.000Z",
      last_used_at: "2026-05-19T09:05:00.000Z",
    }),
  ]);

  assert.equal(picked, null);
});

test("current surface picker ignores stale active-lease markers on historical rows without inventing authority", () => {
  const picked = pickMostRecentCurrentSurface([
    surface({
      surface_id: "surface_stale_active_marker",
      health: "ready",
      active_lease_id: "lease_terminal",
    }),
  ]);

  assert.equal(picked, null);
});
