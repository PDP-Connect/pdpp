// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentReplacementReceipt } from "../runtime/browser-surface/ephemeral-health-projection.ts";
import { createBrowserSurfaceReplacementLedger } from "../runtime/browser-surface/replacement-receipt-ledger.ts";
import { closeDb, initDb } from "../server/db.ts";
import { getDefaultBrowserSurfaceReplacementReceiptStore } from "../server/stores/browser-surface-replacement-ledger-store.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

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

test("failed successor remains readable as system runtime evidence without becoming a current generation", async () => {
  const { readCurrentReplacementReceipt, readSystemActionableReplacementReceipt } = await import(
    "../runtime/browser-surface/replacement-receipt-reader.ts"
  );
  const reader = {
    selectCurrent: async () => null,
    selectSystemActionable: async () => receipt({ phase: "terminal" }),
  };
  const current = await readCurrentReplacementReceipt({ connection_id: "chatgpt:connection-a", reader });
  const actionable = await readSystemActionableReplacementReceipt({
    connection_id: "chatgpt:connection-a",
    profile_key: "chatgpt:connection-a",
    reader,
  });
  assert.equal(current.receipt, null, "a terminal replacement is not a current generation");
  assert.equal(actionable.receipt?.phase, "terminal");
});

test("idle dynamic health reads a matching failed successor but ignores an obsolete profile binding", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-actionable-receipt-"));
  t.after(closeDb);
  const { projectEphemeralBrowserSurfaceHealth } = await import(
    "../runtime/browser-surface/ephemeral-health-projection.ts"
  );
  const { readProcessBoundCurrentReplacementReceipt } = await import(
    "../runtime/browser-surface/health-summary-adapter.ts"
  );
  const ledger = createBrowserSurfaceReplacementLedger();
  const store = getDefaultBrowserSurfaceReplacementReceiptStore();
  const started = ledger.start({
    cause: "external_or_host_loss",
    connection_id: "chatgpt:connection-a",
    idempotency_key: "failed-successor-a",
    profile_key: "chatgpt:connection-a",
    surface_id: "surface-lost",
    surface_subject_id: "chatgpt:connection-a",
  });
  await store.append(started);
  await store.append(
    ledger.terminate({
      cause: started.cause,
      connection_id: started.connection_id,
      outcome: "failed",
      profile_key: started.profile_key,
      replacement_id: started.replacement_id,
      ...(started.surface_id ? { surface_id: started.surface_id } : {}),
      ...(started.surface_subject_id ? { surface_subject_id: started.surface_subject_id } : {}),
    })
  );
  assert.equal(
    (
      await store.selectSystemActionable({
        connection_id: "chatgpt:connection-a",
        profile_key: "chatgpt:connection-a",
        surface_subject_id: "chatgpt:connection-a",
      })
    )?.phase,
    "terminal"
  );
  const base = {
    connectionId: "chatgpt:connection-a",
    connectorId: "chatgpt",
    demand: "none" as const,
    inventory: null,
    reader: { listLeases: async () => [], listSurfaces: async () => [] },
    remoteSurface: null,
    surfaceMode: "dynamic-managed" as const,
  };
  const matching = await readProcessBoundCurrentReplacementReceipt({
    ...base,
    profileKey: "chatgpt:connection-a",
  });
  assert.equal(matching.receipt?.phase, "terminal");
  assert.equal(
    projectEphemeralBrowserSurfaceHealth({
      connection_id: base.connectionId,
      connection_kind: "browser-runtime",
      current_replacement_receipt: matching.receipt,
      demand: "none",
      surface_mode: "dynamic-managed",
    }).credential_continuity,
    "indeterminate"
  );
  const obsolete = await readProcessBoundCurrentReplacementReceipt({
    ...base,
    profileKey: "chatgpt:connection-b",
  });
  assert.equal(obsolete.receipt, null, "a stale profile's failure cannot degrade the replacement binding");
});

test("idle dynamic health ignores failed idle and operator stop history", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-stop-history-receipt-"));
  t.after(closeDb);
  const { projectEphemeralBrowserSurfaceHealth } = await import(
    "../runtime/browser-surface/ephemeral-health-projection.ts"
  );
  const { readProcessBoundCurrentReplacementReceipt } = await import(
    "../runtime/browser-surface/health-summary-adapter.ts"
  );
  const ledger = createBrowserSurfaceReplacementLedger();
  const store = getDefaultBrowserSurfaceReplacementReceiptStore();
  const failedStops = (["idle_ttl", "operator_requested"] as const).flatMap((cause) => {
    const started = ledger.start({
      cause,
      connection_id: "chatgpt:connection-a",
      idempotency_key: `failed-stop-${cause}`,
      profile_key: "chatgpt:connection-a",
      surface_id: `surface-${cause}`,
      surface_subject_id: "chatgpt:connection-a",
    });
    return [
      started,
      ledger.terminate({
        cause: started.cause,
        connection_id: started.connection_id,
        outcome: "failed",
        profile_key: started.profile_key,
        replacement_id: started.replacement_id,
        ...(started.surface_id ? { surface_id: started.surface_id } : {}),
        ...(started.surface_subject_id ? { surface_subject_id: started.surface_subject_id } : {}),
      }),
    ];
  });
  await Promise.all(failedStops.map((failedStop) => store.append(failedStop)));
  const read = await readProcessBoundCurrentReplacementReceipt({
    connectionId: "chatgpt:connection-a",
    connectorId: "chatgpt",
    demand: "none",
    inventory: null,
    profileKey: "chatgpt:connection-a",
    reader: { listLeases: async () => [], listSurfaces: async () => [] },
    remoteSurface: null,
    surfaceMode: "dynamic-managed",
  });
  assert.equal(read.receipt, null);
  assert.equal(
    projectEphemeralBrowserSurfaceHealth({
      connection_id: "chatgpt:connection-a",
      connection_kind: "browser-runtime",
      current_replacement_receipt: read.receipt,
      demand: "none",
      surface_mode: "dynamic-managed",
    }).credential_continuity,
    "not_applicable"
  );
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
