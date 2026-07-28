// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver cannot model this installed package export
import type { BrowserSurface } from "@opendatalabs/remote-surface/leases";
import { pickMostRecentCurrentSurface } from "../server/browser-surface-selection.ts";

type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

function omitUndefined<T extends object>(value: Overrides<T>): T {
  const result = {} as T;
  for (const key of Object.keys(value) as (keyof T)[]) {
    const propertyValue = value[key];
    if (propertyValue !== undefined) {
      result[key] = propertyValue;
    }
  }
  return result;
}

function surface(overrides: Overrides<BrowserSurface> = {}): BrowserSurface {
  const defaults: BrowserSurface = {
    backend: "neko",
    cdp_url: "http://neko:9222",
    connector_id: "chatgpt",
    created_at: "2026-05-19T10:00:00.000Z",
    health: "ready",
    last_used_at: "2026-05-19T10:05:00.000Z",
    profile_key: "chatgpt",
    stream_base_url: "http://neko:8080",
    surface_id: "surface_default",
  };
  return omitUndefined<BrowserSurface>({ ...defaults, ...overrides });
}

test("current surface picker returns the newest ready unleased surface over older unhealthy history", () => {
  const picked = pickMostRecentCurrentSurface([
    surface({
      created_at: "2026-05-19T09:00:00.000Z",
      health: "unhealthy",
      last_used_at: "2026-05-19T09:05:00.000Z",
      surface_id: "surface_old_history",
    }),
    surface({
      created_at: "2026-05-19T11:00:00.000Z",
      health: "ready",
      last_used_at: "2026-05-19T11:59:00.000Z",
      surface_id: "surface_current_ready",
    }),
  ]);

  assert.equal(picked?.surface_id, "surface_current_ready");
});

test("current surface picker ignores released unhealthy history when no current evidence remains", () => {
  const picked = pickMostRecentCurrentSurface([
    surface({
      active_lease_id: undefined,
      created_at: "2026-05-19T09:00:00.000Z",
      health: "unhealthy",
      last_used_at: "2026-05-19T09:05:00.000Z",
      surface_id: "surface_released_history",
    }),
  ]);

  assert.equal(picked, null);
});

test("current surface picker ignores stale active-lease markers on historical rows without inventing authority", () => {
  const picked = pickMostRecentCurrentSurface([
    surface({
      active_lease_id: "lease_terminal",
      health: "ready",
      surface_id: "surface_stale_active_marker",
    }),
  ]);

  assert.equal(picked, null);
});
