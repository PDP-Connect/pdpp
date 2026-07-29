// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { deriveReferenceFreshness } from "../server/freshness.ts";

const NOW = "2026-05-01T12:00:00.000Z";

test("deriveReferenceFreshness reports current inside maximum staleness", () => {
  assert.deepEqual(
    deriveReferenceFreshness({
      lastAttemptedAt: "2026-05-01T11:30:00.000Z",
      lastAttemptStatus: "succeeded",
      lastSuccessfulRunAt: "2026-05-01T11:30:00.000Z",
      maximumStalenessSeconds: 3600,
      now: NOW,
    }),
    {
      captured_at: "2026-05-01T11:30:00.000Z",
      last_attempted_at: "2026-05-01T11:30:00.000Z",
      status: "current",
    }
  );
});

test("deriveReferenceFreshness reports stale outside maximum staleness", () => {
  assert.deepEqual(
    deriveReferenceFreshness({
      lastAttemptedAt: "2026-05-01T09:00:00.000Z",
      lastAttemptStatus: "succeeded",
      lastSuccessfulRunAt: "2026-05-01T09:00:00.000Z",
      maximumStalenessSeconds: 3600,
      now: NOW,
    }),
    {
      captured_at: "2026-05-01T09:00:00.000Z",
      last_attempted_at: "2026-05-01T09:00:00.000Z",
      status: "stale",
    }
  );
});

test("deriveReferenceFreshness reports stale for latest failed attempt after success", () => {
  assert.deepEqual(
    deriveReferenceFreshness({
      lastAttemptedAt: "2026-05-01T11:55:00.000Z",
      lastAttemptStatus: "failed",
      lastSuccessfulRunAt: "2026-05-01T11:45:00.000Z",
      maximumStalenessSeconds: 3600,
      now: NOW,
    }),
    {
      captured_at: "2026-05-01T11:45:00.000Z",
      last_attempted_at: "2026-05-01T11:55:00.000Z",
      status: "stale",
    }
  );
});

test("deriveReferenceFreshness does not fabricate attempted time from record timestamps", () => {
  assert.deepEqual(
    deriveReferenceFreshness({
      now: NOW,
      recordLastUpdatedAt: "2026-05-01T11:45:00.000Z",
    }),
    {
      captured_at: "2026-05-01T11:45:00.000Z",
      status: "unknown",
    }
  );
});

test("deriveReferenceFreshness keeps successful run unknown without maximum staleness policy", () => {
  assert.deepEqual(
    deriveReferenceFreshness({
      lastAttemptedAt: "2026-05-01T11:45:00.000Z",
      lastAttemptStatus: "succeeded",
      lastSuccessfulRunAt: "2026-05-01T11:45:00.000Z",
      now: NOW,
    }),
    {
      captured_at: "2026-05-01T11:45:00.000Z",
      last_attempted_at: "2026-05-01T11:45:00.000Z",
      status: "unknown",
    }
  );
});
