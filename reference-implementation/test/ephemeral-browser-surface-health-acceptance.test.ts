// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type LastSuccessfulRuntimeReceipt,
  type ProjectEphemeralBrowserSurfaceHealthInput,
  projectEphemeralBrowserSurfaceHealth,
} from "../runtime/browser-surface/ephemeral-health-projection.ts";

const NOW = "2026-07-16T12:00:00.000Z";

function historicalRuntimeReceipt(connectionId: string): LastSuccessfulRuntimeReceipt {
  return {
    completed_at: NOW,
    connection_id: connectionId,
    connector_id: connectionId,
    generation: 7,
    lease_id: `${connectionId}:lease`,
    lifecycle: ["ready", "succeeded", "released"],
    profile_key: `${connectionId}:profile`,
    run_id: `${connectionId}:run_current`,
    surface_id: `${connectionId}:surface`,
    surface_subject_id: `${connectionId}:subject`,
  };
}

function dynamicInput(
  connectionId: string,
  overrides: Partial<ProjectEphemeralBrowserSurfaceHealthInput> = {}
): ProjectEphemeralBrowserSurfaceHealthInput {
  return {
    active_lease: null,
    allocator_observation: {
      expires_at: "2026-07-16T12:05:00.000Z",
      observed_at: NOW,
      status: "available",
    },
    connection_id: connectionId,
    connection_kind: "browser-runtime",
    current_compatible_idle_surfaces: 0,
    demand: "none",
    last_successful_runtime_receipt: historicalRuntimeReceipt(connectionId),
    surface_mode: "dynamic-managed",
    ...overrides,
  };
}

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
test("explicit runtime projection keeps H-E-B and Reddit eligible with zero current idle surfaces", async () => {
  for (const connectionId of ["heb", "reddit"]) {
    const result = projectEphemeralBrowserSurfaceHealth(dynamicInput(connectionId));
    assert.deepEqual(
      Object.keys(result).sort(),
      [
        "active_lease",
        "allocator_observation",
        "connection_kind",
        "credential_continuity",
        "current_compatible_idle_surfaces",
        "current_replacement_receipt",
        "demand",
        "health_eligible",
        "last_successful_runtime_receipt",
        "surface_mode",
      ],
      connectionId
    );
    assert.equal(result.health_eligible, true, connectionId);
    assert.equal(result.current_compatible_idle_surfaces, 0, connectionId);
    assert.equal(result.last_successful_runtime_receipt?.connection_id, connectionId, connectionId);
    assert.deepEqual(
      result.last_successful_runtime_receipt?.lifecycle,
      ["ready", "succeeded", "released"],
      connectionId
    );
    assert.equal(result.active_lease, null, connectionId);
  }
});

interface HealthAcceptanceScenario {
  expected: Record<string, unknown>;
  input: ProjectEphemeralBrowserSurfaceHealthInput;
  name: string;
}

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
test("explicit runtime projection is fail-closed across allocator, active-lease, static, and unmanaged matrices", async () => {
  const cases: HealthAcceptanceScenario[] = [
    {
      expected: { allocator_observation: "available", health_eligible: true },
      input: dynamicInput("heb"),
      name: "dynamic allocator available, no demand, zero idle",
    },
    {
      expected: { allocator_observation: "unavailable", health_eligible: false },
      input: dynamicInput("heb", { allocator_observation: { reason: "http", status: "unavailable" } }),
      name: "dynamic allocator unavailable HTTP",
    },
    {
      expected: { allocator_observation: "unavailable", health_eligible: false },
      input: dynamicInput("heb", { allocator_observation: { reason: "fetch", status: "unavailable" } }),
      name: "dynamic allocator unavailable fetch",
    },
    {
      expected: { allocator_observation: "unavailable", health_eligible: false },
      input: dynamicInput("heb", { allocator_observation: { reason: "timeout", status: "unavailable" } }),
      name: "dynamic allocator unavailable timeout",
    },
    {
      expected: { allocator_observation: "unavailable", health_eligible: false },
      input: dynamicInput("heb", { allocator_observation: { reason: "malformed", status: "unavailable" } }),
      name: "dynamic allocator unavailable malformed",
    },
    {
      expected: { allocator_observation: "unknown", health_eligible: false },
      input: dynamicInput("heb", { allocator_observation: { reason: "not_observed", status: "unknown" } }),
      name: "dynamic allocator unknown not observed",
    },
    {
      expected: { allocator_observation: "unknown", health_eligible: false },
      input: dynamicInput("heb", { allocator_observation: { reason: "expired", status: "unknown" } }),
      name: "dynamic allocator unknown expired",
    },
    {
      expected: { allocator_observation: "unknown", health_eligible: false },
      input: dynamicInput("heb", {
        active_lease: { health: "ready", lease_id: "lease_1", surface_id: "surface_1" },
        allocator_observation: { reason: "not_observed", status: "unknown" },
      }),
      name: "active healthy lease still fail closed without allocator certainty",
    },
    {
      expected: { health_eligible: false },
      input: dynamicInput("heb", {
        active_lease: { health: "unhealthy", lease_id: "lease_1", surface_id: "surface_1" },
      }),
      name: "active unhealthy lease worst-wins",
    },
    {
      expected: { health_eligible: false },
      input: dynamicInput("heb", {
        active_lease: { health: "missing", lease_id: "lease_1", surface_id: "surface_missing" },
      }),
      name: "active lease with missing surface is not green",
    },
    {
      expected: { health_eligible: true },
      input: {
        connection_id: "static-a",
        connection_kind: "browser-runtime",
        demand: "none",
        static_surface: { readable: true, status: "ready" },
        surface_mode: "static-managed",
      },
      name: "static ready",
    },
    {
      expected: { health_eligible: false },
      input: {
        connection_id: "static-a",
        connection_kind: "browser-runtime",
        demand: "none",
        static_surface: { readable: true, status: "absent" },
        surface_mode: "static-managed",
      },
      name: "static absent",
    },
    {
      expected: { health_eligible: false },
      input: {
        connection_id: "static-a",
        connection_kind: "browser-runtime",
        demand: "none",
        static_surface: { readable: true, status: "unhealthy" },
        surface_mode: "static-managed",
      },
      name: "static unhealthy",
    },
    {
      expected: { health_eligible: false },
      input: {
        connection_id: "static-a",
        connection_kind: "browser-runtime",
        demand: "none",
        static_surface: { readable: false, status: "unknown" },
        surface_mode: "static-managed",
      },
      name: "static unreadable",
    },
    {
      expected: { health_eligible: true, surface_mode: "none" },
      input: {
        connection_id: "host-browser",
        connection_kind: "unmanaged-browser",
        demand: "none",
        surface_mode: "none",
      },
      name: "unmanaged browser",
    },
    {
      expected: { health_eligible: true, surface_mode: "none" },
      input: { connection_id: "api", connection_kind: "non-browser", demand: "none", surface_mode: "none" },
      name: "non-browser",
    },
    {
      expected: { health_eligible: true, surface_mode: "none" },
      input: { connection_id: "device", connection_kind: "local-device", demand: "none", surface_mode: "none" },
      name: "local device",
    },
  ];

  for (const scenario of cases) {
    const result = projectEphemeralBrowserSurfaceHealth(scenario.input);
    const resultRecord = result as unknown as Record<string, unknown>;
    for (const [field, expected] of Object.entries(scenario.expected)) {
      const actual = field === "allocator_observation" ? result.allocator_observation?.status : resultRecord[field];
      assert.equal(actual, expected, scenario.name);
    }
  }
});

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
test("H-E-B and Reddit require a ready current lease for active dynamic demand", async () => {
  for (const connectionId of ["heb", "reddit"]) {
    const missingLease = projectEphemeralBrowserSurfaceHealth(
      dynamicInput(connectionId, {
        active_lease: null,
        demand: "active",
      })
    );
    assert.equal(missingLease.health_eligible, false, `${connectionId}: active demand cannot be green without a lease`);

    const readyLease = projectEphemeralBrowserSurfaceHealth(
      dynamicInput(connectionId, {
        active_lease: { health: "ready", lease_id: `${connectionId}:lease`, surface_id: `${connectionId}:surface` },
        demand: "active",
      })
    );
    assert.equal(
      readyLease.health_eligible,
      true,
      `${connectionId}: current available allocator plus matching ready lease is green`
    );

    const unavailableAllocator = projectEphemeralBrowserSurfaceHealth(
      dynamicInput(connectionId, {
        active_lease: { health: "ready", lease_id: `${connectionId}:lease`, surface_id: `${connectionId}:surface` },
        allocator_observation: { reason: "not_observed", status: "unknown" },
        demand: "active",
      })
    );
    assert.equal(
      unavailableAllocator.health_eligible,
      false,
      `${connectionId}: lease cannot override allocator currentness`
    );

    for (const health of ["unhealthy", "missing"] as const) {
      const negative = projectEphemeralBrowserSurfaceHealth(
        dynamicInput(connectionId, {
          active_lease: { health, lease_id: `${connectionId}:lease`, surface_id: `${connectionId}:surface` },
          demand: "active",
        })
      );
      assert.equal(negative.health_eligible, false, `${connectionId}: active ${health} surface is not green`);
    }
  }
});

// biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
test("expired available allocator observations fail closed as unknown", async () => {
  const result = projectEphemeralBrowserSurfaceHealth({
    ...dynamicInput("reddit"),
    now: "2026-07-16T12:06:00.000Z",
  });
  assert.equal(result.allocator_observation?.status, "unknown");
  assert.equal(result.allocator_observation?.reason, "expired");
  assert.equal(result.health_eligible, false);
});
