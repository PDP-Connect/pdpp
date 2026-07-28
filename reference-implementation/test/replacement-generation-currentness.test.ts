// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

test("retained history does not hide the one independently current surface generation", async () => {
  const { selectCurrentBrowserGenerationHash } = await import(
    "../runtime/browser-surface/replacement-generation-currentness.ts"
  );
  const input = {
    connection_id: "heb:account-a",
    connector_id: "heb",
    current_surface_ids: new Set(["surface-current"]),
    profile_key: "heb:account-a",
    surfaces: [
      {
        browser_generation_hash: "old-1",
        connector_id: "heb",
        profile_key: "heb:account-a",
        surface_id: "surface-history-1",
        surface_subject_id: "heb:account-a",
      },
      {
        browser_generation_hash: "old-2",
        connector_id: "heb",
        profile_key: "heb:account-a",
        surface_id: "surface-history-2",
        surface_subject_id: "heb:account-a",
      },
      {
        browser_generation_hash: "current",
        connector_id: "heb",
        profile_key: "heb:account-a",
        surface_id: "surface-current",
        surface_subject_id: "heb:account-a",
      },
    ],
  };
  assert.equal(selectCurrentBrowserGenerationHash(input), "current");
});

test("zero or ambiguous current process generations cannot select a completed receipt", async () => {
  const { selectCurrentBrowserGenerationHash } = await import(
    "../runtime/browser-surface/replacement-generation-currentness.ts"
  );
  const scope = {
    connection_id: "reddit:account-a",
    connector_id: "reddit",
    profile_key: "reddit:account-a",
  };
  const surfaces = [
    {
      browser_generation_hash: "current-a",
      connector_id: "reddit",
      profile_key: "reddit:account-a",
      surface_id: "surface-a",
      surface_subject_id: "reddit:account-a",
    },
    {
      browser_generation_hash: "current-b",
      connector_id: "reddit",
      profile_key: "reddit:account-a",
      surface_id: "surface-b",
      surface_subject_id: "reddit:account-a",
    },
  ];
  assert.equal(selectCurrentBrowserGenerationHash({ ...scope, current_surface_ids: new Set(), surfaces }), null);
  assert.equal(
    selectCurrentBrowserGenerationHash({
      ...scope,
      current_surface_ids: new Set(["surface-a", "surface-b"]),
      surfaces,
    }),
    null
  );
});

test("dormant dynamic pending replacement is not current, while active replacement remains a continuity boundary", async () => {
  const { shouldJoinCurrentReplacementReceipt } = await import(
    "../runtime/browser-surface/replacement-generation-currentness.ts"
  );
  const { projectEphemeralBrowserSurfaceHealth } = await import(
    "../runtime/browser-surface/ephemeral-health-projection.ts"
  );
  const pending: import("../runtime/browser-surface/ephemeral-health-projection.ts").CurrentReplacementReceipt = {
    connection_id: "heb:account-a",
    phase: "started",
    replacement_id: "replacement-pending",
    surface_subject_id: "heb:account-a",
  };
  const dormant = shouldJoinCurrentReplacementReceipt({
    current_surface_ids: new Set(),
    demand: "none",
    surface_mode: "dynamic-managed",
  });
  const active = shouldJoinCurrentReplacementReceipt({
    current_surface_ids: new Set(),
    demand: "active",
    surface_mode: "dynamic-managed",
  });
  assert.equal(dormant, false, "no-demand/zero-surface H-E-B scale-to-zero does not join a dormant start");
  assert.equal(active, true, "a new active replacement still joins its pending receipt");

  const base: import("../runtime/browser-surface/ephemeral-health-projection.ts").ProjectEphemeralBrowserSurfaceHealthInput =
    {
      allocator_observation: { status: "available" },
      connection_id: "heb:account-a",
      connection_kind: "browser-runtime",
      demand: "none",
      surface_mode: "dynamic-managed",
    };
  const dormantRuntime = projectEphemeralBrowserSurfaceHealth(base);
  const activeRuntime = projectEphemeralBrowserSurfaceHealth({
    ...base,
    active_lease: { health: "ready", lease_id: "lease-a", surface_id: "surface-a" },
    current_replacement_receipt: pending,
    demand: "active",
  });
  assert.equal(dormantRuntime.credential_continuity, "not_applicable");
  assert.equal(activeRuntime.credential_continuity, "replacement_pending");
});

test("current replacement IDs require exact scope and live remote or inventory evidence", async () => {
  const { currentSurfaceIdsForReplacementReceipt } = await import(
    "../runtime/browser-surface/replacement-generation-currentness.ts"
  );
  const currentSurfaceIds = currentSurfaceIdsForReplacementReceipt({
    connection_id: "reddit:account-a",
    connector_id: "reddit",
    inventory_surfaces: [
      {
        connector_id: "reddit",
        health: "starting",
        profile_key: "reddit:account-a",
        surface_id: "inventory-current",
        surface_subject_id: "reddit:account-a",
      },
      {
        connector_id: "reddit",
        health: "unhealthy",
        profile_key: "reddit:account-a",
        surface_id: "inventory-unhealthy",
        surface_subject_id: "reddit:account-a",
      },
      {
        connector_id: "reddit",
        health: "ready",
        profile_key: "reddit:account-b",
        surface_id: "inventory-wrong-profile",
        surface_subject_id: "reddit:account-a",
      },
    ],
    persisted_surfaces: [
      {
        connector_id: "reddit",
        health: "ready",
        profile_key: "reddit:account-a",
        surface_id: "remote-current",
        surface_subject_id: "reddit:account-a",
      },
      {
        connector_id: "reddit",
        health: "ready",
        profile_key: "reddit:account-a",
        surface_id: "remote-wrong-subject",
        surface_subject_id: "reddit:account-b",
      },
    ],
    profile_key: "reddit:account-a",
    remote_surface_id: "remote-current",
  });

  assert.deepEqual([...currentSurfaceIds], ["remote-current", "inventory-current"]);
});

test("Reddit retained stopping surface does not make an idle-TTL pending receipt current", async () => {
  const { currentSurfaceIdsForReplacementReceipt, shouldJoinCurrentReplacementReceipt } = await import(
    "../runtime/browser-surface/replacement-generation-currentness.ts"
  );
  const { projectEphemeralBrowserSurfaceHealth } = await import(
    "../runtime/browser-surface/ephemeral-health-projection.ts"
  );
  const stopping: import("../runtime/browser-surface/replacement-generation-currentness.ts").BrowserSurfaceCurrentnessRow =
    {
      browser_generation_hash: "retired-generation",
      connector_id: "reddit",
      health: "stopping",
      profile_key: "reddit:account-a",
      surface_id: "reddit-retained-stopping",
      surface_subject_id: "reddit:account-a",
    };
  const currentSurfaceIds = currentSurfaceIdsForReplacementReceipt({
    connection_id: "reddit:account-a",
    connector_id: "reddit",
    inventory_surfaces: [stopping],
    persisted_surfaces: [stopping],
    profile_key: "reddit:account-a",
    remote_surface_id: "reddit-retained-stopping",
  });
  assert.deepEqual([...currentSurfaceIds], [], "stopping persisted/inventory rows are not current processes");
  assert.equal(
    shouldJoinCurrentReplacementReceipt({
      current_surface_ids: currentSurfaceIds,
      demand: "none",
      surface_mode: "dynamic-managed",
    }),
    false,
    "the dormant idle-TTL receipt is not read from Luna"
  );
  const runtime = projectEphemeralBrowserSurfaceHealth({
    allocator_observation: { status: "available" },
    connection_id: "reddit:account-a",
    connection_kind: "browser-runtime",
    demand: "none",
    surface_mode: "dynamic-managed",
  });
  assert.equal(runtime.health_eligible, true);
  assert.equal(runtime.credential_continuity, "not_applicable");
});
