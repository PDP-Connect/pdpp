// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import type { BrowserSurface, BrowserSurfaceAllocator } from "@opendatalabs/remote-surface/leases";
import type { LastSuccessfulRuntimeReceipt } from "../runtime/browser-surface/ephemeral-health-projection.ts";
import {
  type BrowserSurfaceRepairEvidence,
  decideBrowserSurfaceRepair,
  type ProviderInvalidationProof,
} from "../runtime/browser-surface/repair-decision.ts";
import {
  createBrowserSurfaceReplacementLedger,
  createReplacementObservingAllocator,
  deriveOpaqueGenerationHash,
  type ReplacementReceipt,
} from "../runtime/browser-surface/replacement-receipt-ledger.ts";
import {
  evaluateLastSuccessfulRuntimeReceipt,
  isSucceededRunCompletionEvent,
} from "../runtime/browser-surface/runtime-receipts.ts";

const NOW = "2026-07-16T12:00:00.000Z";

function runtimeReceipt(connectionId: string): LastSuccessfulRuntimeReceipt {
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

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
test("LastSuccessfulRuntimeReceipt is historical-only, exact, bounded, and separate from replacement causes", async () => {
  const receipt = runtimeReceipt("connection-a");
  const context = {
    ...receipt,
    max_age_ms: 15 * 60 * 1000,
    now: NOW,
  };
  const accepted = evaluateLastSuccessfulRuntimeReceipt(receipt, context);
  assert.equal(accepted.valid, true);
  assert.equal(accepted.authority, "historical_only");
  assert.deepEqual(accepted.lifecycle, ["ready", "succeeded", "released"]);

  const mismatches: [string, Partial<LastSuccessfulRuntimeReceipt>][] = [
    ["prior run", { run_id: "connection-a:run_prior" }],
    ["old age", { completed_at: "2026-07-15T12:00:00.000Z" }],
    ["connection mismatch", { connection_id: "connection-b" }],
    ["profile mismatch", { profile_key: "connection-b:profile" }],
    ["surface subject mismatch", { surface_subject_id: "connection-b:subject" }],
    ["surface mismatch", { surface_id: "connection-b:surface" }],
    ["lease mismatch", { lease_id: "connection-b:lease" }],
    ["generation mismatch", { generation: 6 }],
    // Deliberately the WRONG lifecycle order — proves the evaluator rejects
    // out-of-sequence lifecycles, not just missing ones. Cast because the
    // real type is the exact ["ready","succeeded","released"] tuple; this
    // wrong-order array is intentionally not that type.
    [
      "sequence/order mismatch",
      { lifecycle: ["ready", "released", "succeeded"] as unknown as LastSuccessfulRuntimeReceipt["lifecycle"] },
    ],
    ["time mismatch", { completed_at: "2026-07-16T12:30:00.000Z" }],
  ];
  for (const [name, change] of mismatches) {
    assert.equal(evaluateLastSuccessfulRuntimeReceipt({ ...receipt, ...change }, context).valid, false, name);
  }
});

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
test("H-E-B and Reddit runtime success fixture accepts only the emitted succeeded completion shape", async () => {
  for (const connector_id of ["heb", "reddit"]) {
    const context = { connector_id, run_id: `${connector_id}:run_1` };
    const emitted = {
      actor_id: connector_id,
      event_type: "run.completed",
      run_id: `${connector_id}:run_1`,
      status: "succeeded",
    };
    assert.equal(isSucceededRunCompletionEvent(emitted, context), true, connector_id);
    assert.equal(
      isSucceededRunCompletionEvent({ ...emitted, event_type: "run.progress" }, context),
      false,
      "a generic succeeded status is not a run completion"
    );
    assert.equal(
      isSucceededRunCompletionEvent({ ...emitted, status: "completed" }, context),
      false,
      "the event-type word is not the runtime done status"
    );
    assert.equal(isSucceededRunCompletionEvent({ ...emitted, actor_id: "other" }, context), false, "actor is exact");
    assert.equal(isSucceededRunCompletionEvent({ ...emitted, run_id: "other:run" }, context), false, "run is exact");
  }
});

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
test("replacement receipt ledger covers corrected causes, two phases, deterministic idempotency, and redaction", async () => {
  const causes = [
    "capacity_pressure",
    "idle_ttl",
    "operator_requested",
    "restart_reconcile",
    "readiness_invalidated",
    "allocator_internal_ensure_surface",
    "same_container_browser_generation_change",
    "external_or_host_loss",
  ];
  const ledger = createBrowserSurfaceReplacementLedger({ idPrefix: "replacement", now: () => NOW });

  for (const cause of causes) {
    const started = ledger.start({
      cause,
      connection_id: "connection-a",
      previous_generation: 7,
      profile_key: "connection-a:profile",
      surface_subject_id: "connection-a:subject",
    });
    assert.equal(started.phase, "started", cause);
    const completed = ledger.complete({
      cause,
      connection_id: "connection-a",
      next_generation: 8,
      replacement_id: started.replacement_id,
    });
    assert.equal(completed.phase, "completed", cause);
    assert.equal(completed.replacement_id, started.replacement_id, cause);
    // ReplacementReceipt has no `secret` field in its type — this is the
    // static half of that redaction guarantee. Still check the runtime
    // object directly (via an unknown-record view) so a future field named
    // `secret` sneaking onto the wire object would still be caught.
    assert.equal(
      (completed as unknown as Record<string, unknown>).secret,
      undefined,
      "replacement receipt is redacted"
    );
    assert.deepEqual(
      ledger.complete({
        cause,
        connection_id: "connection-a",
        next_generation: 8,
        replacement_id: started.replacement_id,
      }),
      completed,
      `idempotent completion for ${cause}`
    );
  }
});

test("allocator fakes preserve two independent container replacement causal chains", async () => {
  function surface(subject: string, id: string, container: string): BrowserSurface {
    return {
      backend: "neko",
      cdp_url: `http://neko/${id}`,
      connector_id: "chatgpt",
      container_id: container,
      created_at: NOW,
      health: "ready",
      last_used_at: NOW,
      profile_key: "shared-profile-key",
      stream_base_url: `http://neko/${id}/stream`,
      surface_id: id,
      surface_subject_id: subject,
    };
  }

  async function replacement(subject: string, id: string, oldContainer: string, newContainer: string) {
    const oldSurface = surface(subject, id, oldContainer);
    const newSurface = surface(subject, id, newContainer);
    const ledger = createBrowserSurfaceReplacementLedger({ idPrefix: "replacement", now: () => NOW });
    const persisted: ReplacementReceipt[] = [];
    const observed: BrowserSurfaceAllocator = createReplacementObservingAllocator(
      {
        ensureSurface: async () => newSurface,
        getSurfaceStatus: async () => oldSurface,
        listSurfaces: async () => [newSurface],
        stopSurface: async () => null,
      },
      {
        ledger,
        // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
        persist: async (receipt) => {
          persisted.push(receipt);
          return receipt;
        },
      }
    );
    await observed.ensureSurface({
      connectorId: "chatgpt",
      profileKey: "shared-profile-key",
      surfaceId: id,
      surfaceSubjectId: subject,
    });
    // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
    const started = persisted[0];
    assert.ok(started, "the ensureSurface call must have persisted a started replacement receipt");
    const browserGenerationHash = deriveOpaqueGenerationHash(`${id}:post-readiness-cdp-generation`);
    const completed = ledger.complete({
      cause: started.cause,
      connection_id: started.connection_id,
      next_generation_hash: browserGenerationHash,
      profile_key: started.profile_key,
      replacement_id: started.replacement_id,
      surface_id: id,
      surface_subject_id: subject,
    });
    persisted.push(completed);
    return { browserGenerationHash, completed, ledger, persisted };
  }

  const first = await replacement("connection-a:subject", "surface-a", "container-a-old", "container-a-new");
  const second = await replacement("connection-b:subject", "surface-b", "container-b-old", "container-b-new");
  const combined = createBrowserSurfaceReplacementLedger({ idPrefix: "combined", now: () => NOW });
  combined.hydrate([...first.persisted, ...second.persisted]);

  assert.deepEqual(
    first.persisted.map((receipt) => receipt.phase),
    ["started", "completed"]
  );
  assert.deepEqual(
    second.persisted.map((receipt) => receipt.phase),
    ["started", "completed"]
  );
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const firstStarted = first.persisted[0];
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const secondStarted = second.persisted[0];
  assert.ok(firstStarted, "first replacement chain must have persisted a started receipt");
  assert.ok(secondStarted, "second replacement chain must have persisted a started receipt");
  assert.notEqual(firstStarted.replacement_id, secondStarted.replacement_id);
  assert.notEqual(first.completed.scope, second.completed.scope);
  assert.equal(
    combined.selectCurrent("connection-a:subject", "connection-a:subject", first.browserGenerationHash)?.replacement_id,
    first.completed.replacement_id
  );
  assert.equal(
    combined.selectCurrent("connection-b:subject", "connection-b:subject", second.browserGenerationHash)
      ?.replacement_id,
    second.completed.replacement_id
  );
  assert.equal(
    combined.selectCurrent("connection-a:subject", "connection-a:subject", second.browserGenerationHash),
    null
  );
  assert.equal(
    combined.selectCurrent("connection-b:subject", "connection-b:subject", first.browserGenerationHash),
    null
  );
  // Provider-session survival and an exact authenticated provider probe across both replacements remain a separate OPEN live gate.
});

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
test("typed repair decision requires provider proof, rejects ambiguous evidence, and deduplicates per connection", async () => {
  const noProofEvidence: BrowserSurfaceRepairEvidence[] = [
    { kind: "replacement_verification_pending" },
    { kind: "session_probe_false" },
    { kind: "session_probe_indeterminate" },
    { kind: "ambiguous_dom_profile_evidence" },
  ];
  for (const evidence of noProofEvidence) {
    assert.equal(decideBrowserSurfaceRepair({ connection_id: "connection-a", evidence }).action, "none", evidence.kind);
  }
  assert.throws(
    () =>
      decideBrowserSurfaceRepair({
        connection_id: "connection-a",
        evidence: "provider_proven_invalidation" as unknown as BrowserSurfaceRepairEvidence,
      }),
    "arbitrary strings cannot manufacture repair authority"
  );

  const proof: ProviderInvalidationProof = {
    connection_id: "connection-a",
    evidence_id: "provider-proof-a",
    kind: "provider_invalidation_proof",
    observed_at: NOW,
    provider: "chatgpt",
    verified: true,
  };
  const first = decideBrowserSurfaceRepair({ connection_id: "connection-a", evidence: proof });
  assert.equal(first.action, "repair");
  assert.ok(first.dedupe_key, "a proven repair must mint a dedupe key");
  assert.equal(
    decideBrowserSurfaceRepair({
      connection_id: "connection-a",
      evidence: proof,
      repaired_proof_keys: [first.dedupe_key],
    }).action,
    "none",
    "durable, explicit proof identity deduplicates one connection"
  );
  const otherProof: ProviderInvalidationProof = { ...proof, connection_id: "connection-b" };
  assert.equal(
    decideBrowserSurfaceRepair({ connection_id: "connection-b", evidence: otherProof }).action,
    "repair",
    "other connection remains independently actionable"
  );
});
