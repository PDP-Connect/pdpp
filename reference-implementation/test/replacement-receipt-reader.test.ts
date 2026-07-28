// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentReplacementReceipt } from "../runtime/browser-surface/ephemeral-health-projection.ts";

interface ReceiptOverrides {
  connection_id?: CurrentReplacementReceipt["connection_id"];
  phase?: CurrentReplacementReceipt["phase"];
  replacement_id?: CurrentReplacementReceipt["replacement_id"];
  surface_subject_id?: string | undefined;
}

function receipt(overrides: ReceiptOverrides = {}): CurrentReplacementReceipt {
  const connection_id = overrides.connection_id ?? "chatgpt:connection-a";
  const replacement_id = overrides.replacement_id ?? "replacement-a";
  const phase = overrides.phase ?? "started";
  if ("surface_subject_id" in overrides && overrides.surface_subject_id === undefined) {
    return { connection_id, phase, replacement_id };
  }
  const surface_subject_id = overrides.surface_subject_id ?? "chatgpt:connection-a";
  return { connection_id, phase, replacement_id, surface_subject_id };
}

test("current started receipt is scoped and defaults the health view to replacement_pending", async () => {
  const { readCurrentReplacementReceipt } = await import("../runtime/browser-surface/replacement-receipt-reader.ts");
  const { projectEphemeralBrowserSurfaceHealth } = await import(
    "../runtime/browser-surface/ephemeral-health-projection.ts"
  );
  const observed: Array<{
    readonly connection_id: string;
    readonly surface_subject_id?: string;
    readonly current_generation_hash?: string;
  }> = [];
  const current = await readCurrentReplacementReceipt({
    connection_id: "chatgpt:connection-a",
    reader: {
      selectCurrent: (input) => {
        observed.push(input);
        return receipt();
      },
    },
    surface_subject_id: "chatgpt:connection-a",
  });
  assert.equal(current.state, "available");
  assert.equal(current.receipt?.phase, "started");
  assert.deepEqual(observed, [
    {
      connection_id: "chatgpt:connection-a",
      surface_subject_id: "chatgpt:connection-a",
    },
  ]);
  const runtime = projectEphemeralBrowserSurfaceHealth({
    connection_id: "chatgpt:connection-a",
    connection_kind: "browser-runtime",
    current_replacement_receipt: current.receipt,
    static_surface: { readable: true, status: "ready" },
    surface_mode: "static-managed",
  });
  assert.equal(runtime.credential_continuity, "replacement_pending");
});

test("completed receipt is delegated to Luna with the independently observed current generation", async () => {
  const { readCurrentReplacementReceipt } = await import("../runtime/browser-surface/replacement-receipt-reader.ts");
  const observed: Array<{
    readonly connection_id: string;
    readonly surface_subject_id?: string;
    readonly current_generation_hash?: string;
  }> = [];
  const current = await readCurrentReplacementReceipt({
    connection_id: "chatgpt:connection-a",
    current_generation_hash: "generation-current",
    reader: {
      selectCurrent: (input) => {
        observed.push(input);
        return input.current_generation_hash === "generation-current" ? receipt({ phase: "completed" }) : null;
      },
    },
    surface_subject_id: "chatgpt:connection-a",
  });
  assert.equal(current.state, "available");
  assert.equal(current.receipt?.phase, "completed");
  assert.deepEqual(observed, [
    {
      connection_id: "chatgpt:connection-a",
      current_generation_hash: "generation-current",
      surface_subject_id: "chatgpt:connection-a",
    },
  ]);
});

test("Luna reader failure fails closed while an ordinary no-replacement selection remains available", async () => {
  const { readCurrentReplacementReceipt } = await import("../runtime/browser-surface/replacement-receipt-reader.ts");
  const { projectEphemeralBrowserSurfaceHealth } = await import(
    "../runtime/browser-surface/ephemeral-health-projection.ts"
  );
  const unavailable = await readCurrentReplacementReceipt({
    connection_id: "chatgpt:connection-a",
    reader: {
      selectCurrent: () => {
        throw new Error("store unavailable");
      },
    },
  });
  assert.deepEqual(unavailable, { receipt: null, state: "unavailable" });

  const noReplacement = await readCurrentReplacementReceipt({
    connection_id: "heb",
    reader: { selectCurrent: async () => null },
  });
  assert.deepEqual(noReplacement, { receipt: null, state: "available" });
  const runtime = projectEphemeralBrowserSurfaceHealth({
    allocator_observation: { status: "available" },
    connection_id: "heb",
    connection_kind: "browser-runtime",
    current_replacement_receipt: noReplacement.receipt,
    surface_mode: "dynamic-managed",
  });
  assert.equal(runtime.credential_continuity, "not_applicable");
});

test("single-instance Luna receipts omit the optional subject but remain connection-scoped", async () => {
  const { readCurrentReplacementReceipt } = await import("../runtime/browser-surface/replacement-receipt-reader.ts");
  const current = await readCurrentReplacementReceipt({
    connection_id: "chatgpt",
    reader: { selectCurrent: async () => receipt({ connection_id: "chatgpt", surface_subject_id: undefined }) },
  });
  assert.equal(current.state, "available");
  assert.equal(current.receipt?.connection_id, "chatgpt");
  assert.equal(current.receipt?.surface_subject_id, undefined);
});
