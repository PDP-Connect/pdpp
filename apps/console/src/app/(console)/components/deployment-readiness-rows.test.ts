// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * biome-ignore-all lint/performance/useTopLevelRegex: These tests use one-off
 * regex assertions for copy contracts; hoisting each literal would make the test
 * intent harder to read without improving runtime behavior.
 *
 * Pure-function tests for the deployment readiness row computations. The
 * panel itself (the React rendering) is browser-side; the row derivations
 * are deterministic given a `ServerInputs` and a browser-side probe.
 *
 * Spec: openspec/changes/archive/2026-05-28-add-selfhost-onboarding-slvp/design.md
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type DiskHeadroomInputs,
  diskHeadroomRow,
  diskHeadroomRows,
  embeddingCacheRow,
  overallVerdict,
  ownerPasswordRow,
  type ReadinessRow,
  referenceOriginRow,
  refreshTokenRow,
  type ServerInputs,
  storageBackendRow,
} from "./deployment-readiness-rows.ts";

const HEALTHY_DISK_HEADROOM: DiskHeadroomInputs = {
  freeBytesOnDataFs: 20 * 1024 * 1024 * 1024, // 20 GiB
  largestRelationBytes: null,
  largestRelationName: null,
  mountLabel: null,
  path: "/data",
  totalBytesOnDataFs: 100 * 1024 * 1024 * 1024,
};

const baseInputs: ServerInputs = {
  databasePath: "/data/pdpp.db",
  diskHeadroom: [HEALTHY_DISK_HEADROOM],
  embeddingBackendAvailable: true,
  embeddingBackendConfigured: true,
  embeddingDownloadAllowed: true,
  embeddingModelCachePresent: true,
  ownerPasswordProvenance: "redacted",
  referenceOriginConfigured: "https://example.com",
  vectorIndexKind: "sqlite-vec",
  vectorIndexState: "built",
};

const OWNER_PASSWORD_ENV_RE = /PDPP_OWNER_PASSWORD/;
const REFERENCE_ORIGIN_ENV_RE = /PDPP_REFERENCE_ORIGIN/;
const AS_ISSUER_ENV_RE = /AS_ISSUER/;
const DOCKER_COMPOSE_PULL_RE = /docker compose pull/;

// ─── Owner password gate ────────────────────────────────────────────────────

test("ownerPasswordRow is ok when password is redacted", () => {
  const row = ownerPasswordRow(baseInputs);
  assert.equal(row.status, "ok");
});

test("ownerPasswordRow is error when password is absent", () => {
  const row = ownerPasswordRow({ ...baseInputs, ownerPasswordProvenance: "absent" });
  assert.equal(row.status, "error");
  assert.match(row.hint ?? "", OWNER_PASSWORD_ENV_RE);
});

// ─── Reference origin alignment ─────────────────────────────────────────────

test("referenceOriginRow is warn when not configured", () => {
  const row = referenceOriginRow({ ...baseInputs, referenceOriginConfigured: null }, "https://example.com");
  assert.equal(row.status, "warn");
});

test("referenceOriginRow is unknown when browser origin not yet observed", () => {
  const row = referenceOriginRow(baseInputs, null);
  assert.equal(row.status, "unknown");
});

test("referenceOriginRow is ok when configured matches browser origin", () => {
  const row = referenceOriginRow(baseInputs, "https://example.com");
  assert.equal(row.status, "ok");
});

test("referenceOriginRow is warn when configured mismatches browser origin", () => {
  const row = referenceOriginRow(baseInputs, "https://other.example.com");
  assert.equal(row.status, "warn");
  assert.match(row.hint ?? "", REFERENCE_ORIGIN_ENV_RE);
});

test("referenceOriginRow ignores trailing slashes when comparing", () => {
  const row = referenceOriginRow(
    { ...baseInputs, referenceOriginConfigured: "https://example.com/" },
    "https://example.com"
  );
  assert.equal(row.status, "ok");
});

// ─── Storage backend ────────────────────────────────────────────────────────

test("storageBackendRow is ok when vector index is built", () => {
  const row = storageBackendRow(baseInputs);
  assert.equal(row.status, "ok");
});

test("storageBackendRow is warn when vector index is stale", () => {
  const row = storageBackendRow({ ...baseInputs, vectorIndexState: "stale" });
  assert.equal(row.status, "warn");
});

test("storageBackendRow is info when vector index is building", () => {
  const row = storageBackendRow({ ...baseInputs, vectorIndexState: "building" });
  assert.equal(row.status, "info");
});

test("storageBackendRow is info when no vector index is configured", () => {
  const row = storageBackendRow({ ...baseInputs, vectorIndexKind: null, vectorIndexState: null });
  assert.equal(row.status, "info");
});

// ─── Embedding cache ────────────────────────────────────────────────────────

test("embeddingCacheRow is ok when cached and backend available", () => {
  const row = embeddingCacheRow(baseInputs);
  assert.equal(row.status, "ok");
});

test("embeddingCacheRow is info when backend not configured", () => {
  const row = embeddingCacheRow({ ...baseInputs, embeddingBackendConfigured: false });
  assert.equal(row.status, "info");
});

test("embeddingCacheRow is error when uncached and download disabled", () => {
  const row = embeddingCacheRow({
    ...baseInputs,
    embeddingBackendAvailable: false,
    embeddingDownloadAllowed: false,
    embeddingModelCachePresent: false,
  });
  assert.equal(row.status, "error");
});

test("embeddingCacheRow is warn while cache is warming", () => {
  const row = embeddingCacheRow({
    ...baseInputs,
    embeddingBackendAvailable: false,
    embeddingDownloadAllowed: true,
    embeddingModelCachePresent: false,
  });
  assert.equal(row.status, "warn");
});

// ─── MCP refresh-token advertisement ────────────────────────────────────────

test("refreshTokenRow is unknown while probe is loading", () => {
  assert.equal(refreshTokenRow({ state: "loading" }).status, "unknown");
});

test("refreshTokenRow is warn when well-known is unreachable", () => {
  const row = refreshTokenRow({ state: "unreachable" });
  assert.equal(row.status, "warn");
  assert.match(row.hint ?? "", AS_ISSUER_ENV_RE);
});

test("refreshTokenRow is ok when refresh_token is advertised", () => {
  assert.equal(refreshTokenRow({ refreshTokenSupported: true, state: "loaded" }).status, "ok");
});

test("refreshTokenRow is error when refresh_token is missing", () => {
  const row = refreshTokenRow({ refreshTokenSupported: false, state: "loaded" });
  assert.equal(row.status, "error");
  assert.match(row.hint ?? "", DOCKER_COMPOSE_PULL_RE);
});

// ─── Overall verdict ────────────────────────────────────────────────────────

test("overallVerdict ready when every row is ok", () => {
  const rows: ReadinessRow[] = [{ check: "x", detail: "", status: "ok" }];
  assert.equal(overallVerdict(rows), "ready");
});

test("overallVerdict blocked when any row is error", () => {
  const rows: ReadinessRow[] = [
    { check: "x", detail: "", status: "ok" },
    { check: "y", detail: "", status: "error" },
    { check: "z", detail: "", status: "warn" },
  ];
  assert.equal(overallVerdict(rows), "blocked");
});

test("overallVerdict attention when any row is warn but none is error", () => {
  const rows: ReadinessRow[] = [
    { check: "x", detail: "", status: "ok" },
    { check: "y", detail: "", status: "warn" },
  ];
  assert.equal(overallVerdict(rows), "attention");
});

test("overallVerdict unknown when probes still loading and nothing worse", () => {
  const rows: ReadinessRow[] = [
    { check: "x", detail: "", status: "ok" },
    { check: "y", detail: "", status: "unknown" },
  ];
  assert.equal(overallVerdict(rows), "unknown");
});

// ─── Disk headroom ───────────────────────────────────────────────────────────

const GiB = 1024 * 1024 * 1024;

function makeEntry(overrides: Partial<DiskHeadroomInputs>): DiskHeadroomInputs {
  return { ...HEALTHY_DISK_HEADROOM, ...overrides };
}

test("diskHeadroomRow is ok when free space is above the warn threshold", () => {
  const row = diskHeadroomRow(baseInputs);
  assert.equal(row.status, "ok");
  assert.match(row.detail, /GiB free/);
});

test("diskHeadroomRow is warn when free space is below 5 GiB but above 2 GiB", () => {
  const row = diskHeadroomRow({
    ...baseInputs,
    diskHeadroom: [makeEntry({ freeBytesOnDataFs: 3 * GiB, totalBytesOnDataFs: 100 * GiB })],
  });
  assert.equal(row.status, "warn");
  assert.match(row.hint ?? "", /docker system prune/);
});

test("diskHeadroomRow is error when free space is below 2 GiB", () => {
  const row = diskHeadroomRow({
    ...baseInputs,
    diskHeadroom: [makeEntry({ freeBytesOnDataFs: 1 * GiB, totalBytesOnDataFs: 50 * GiB })],
  });
  assert.equal(row.status, "error");
  assert.match(row.detail, /No space left on device/);
  assert.match(row.hint ?? "", /docker system prune/);
});

test("diskHeadroomRow is info when no entries (probe not run)", () => {
  const row = diskHeadroomRow({ ...baseInputs, diskHeadroom: [] });
  assert.equal(row.status, "info");
});

test("diskHeadroomRow is info when free_bytes is null (probe failed)", () => {
  const row = diskHeadroomRow({
    ...baseInputs,
    diskHeadroom: [makeEntry({ freeBytesOnDataFs: null, totalBytesOnDataFs: null })],
  });
  assert.equal(row.status, "info");
});

test("diskHeadroomRow hint does not suggest deleting data automatically", () => {
  const errorRow = diskHeadroomRow({
    ...baseInputs,
    diskHeadroom: [makeEntry({ freeBytesOnDataFs: 500 * 1024 * 1024, totalBytesOnDataFs: 50 * GiB })],
  });
  // The hint must never suggest automatic data deletion.
  assert.ok(
    !(
      (errorRow.hint ?? "").toLowerCase().includes("auto-delete") ||
      (errorRow.hint ?? "").toLowerCase().includes("automatically delete")
    ),
    "hint must not suggest automatic data deletion"
  );
  assert.ok(!(errorRow.hint ?? "").includes("--volumes"), "hint must not recommend deleting Docker volumes");
});

// ─── workload-aware warning ──────────────────────────────────────────────────

test("diskHeadroomRow includes workload hint when free < largestRelationBytes", () => {
  const row = diskHeadroomRow({
    ...baseInputs,
    diskHeadroom: [
      makeEntry({
        // 4 GiB free — below warn (5 GiB) and below largest relation (6 GiB).
        freeBytesOnDataFs: 4 * GiB,
        largestRelationBytes: 6 * GiB,
        largestRelationName: "records",
        totalBytesOnDataFs: 100 * GiB,
      }),
    ],
  });
  assert.equal(row.status, "warn");
  assert.match(row.detail, /VACUUM FULL/, "workload hint must mention VACUUM FULL");
  assert.match(row.detail, /records/, "hint names the largest relation");
});

test("diskHeadroomRow omits workload hint when free >= largestRelationBytes", () => {
  const row = diskHeadroomRow({
    ...baseInputs,
    diskHeadroom: [
      makeEntry({
        // 4 GiB free — below warn but ABOVE largest relation (3 GiB).
        freeBytesOnDataFs: 4 * GiB,
        largestRelationBytes: 3 * GiB,
        largestRelationName: "records",
        totalBytesOnDataFs: 100 * GiB,
      }),
    ],
  });
  assert.equal(row.status, "warn");
  assert.ok(!row.detail.includes("VACUUM FULL"), "no workload hint when free >= largest relation");
});

test("diskHeadroomRow omits workload hint when largestRelationBytes is null (SQLite)", () => {
  const row = diskHeadroomRow({
    ...baseInputs,
    diskHeadroom: [
      makeEntry({
        freeBytesOnDataFs: 4 * GiB,
        largestRelationBytes: null,
        largestRelationName: null,
        totalBytesOnDataFs: 100 * GiB,
      }),
    ],
  });
  assert.equal(row.status, "warn");
  assert.ok(!row.detail.includes("VACUUM FULL"), "no hint when footprint unavailable");
});

// ─── multi-mount: diskHeadroomRows ───────────────────────────────────────────

test("diskHeadroomRows returns one row per entry", () => {
  const rows = diskHeadroomRows({
    ...baseInputs,
    diskHeadroom: [
      makeEntry({ freeBytesOnDataFs: 20 * GiB, mountLabel: "data" }),
      makeEntry({ freeBytesOnDataFs: 8 * GiB, mountLabel: "postgres", path: "/var/lib/postgresql/data" }),
    ],
  });
  assert.equal(rows.length, 2);
  const dataRow = rows[0];
  const postgresRow = rows[1];
  assert.ok(dataRow);
  assert.ok(postgresRow);
  assert.match(dataRow.check, /data/);
  assert.equal(dataRow.status, "ok");
  assert.match(postgresRow.check, /postgres/);
  assert.equal(postgresRow.status, "ok");
});

test("diskHeadroomRows returns info row when empty array (no probes ran)", () => {
  const rows = diskHeadroomRows({ ...baseInputs, diskHeadroom: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "info");
});

test("diskHeadroomRows: unmeasured postgres entry shows info, not a false green", () => {
  const rows = diskHeadroomRows({
    ...baseInputs,
    diskHeadroom: [
      makeEntry({ freeBytesOnDataFs: 20 * GiB, mountLabel: "data" }),
      makeEntry({
        freeBytesOnDataFs: null,
        mountLabel: "postgres",
        path: "/var/lib/postgresql/data",
        totalBytesOnDataFs: null,
      }),
    ],
  });
  assert.equal(rows.length, 2);
  const pgRow = rows.find((r) => r.check.includes("postgres"));
  assert.ok(pgRow, "postgres row must be present");
  assert.equal(pgRow?.status, "info", "unmeasured entry must show info, not green");
});
