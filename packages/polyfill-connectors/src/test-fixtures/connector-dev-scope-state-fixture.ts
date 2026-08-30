// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/connector-dev.test.ts`'s `--streams`
 * and `--seed-last-state` proofs.
 *
 * Declares two streams (`items`, `extras`) — matching `bin/connector-dev.ts`'s
 * `ENTRYPOINT_MODE_STREAMS` — and makes both flags' effects OBSERVABLE on
 * stdout rather than just plumbing that gets exercised without affecting
 * anything:
 *
 *   - `--streams` scoping: emits a `PROGRESS` line naming exactly the
 *     streams `ctx.requested` (built by connector-runtime.ts from
 *     `START.scope.streams`) actually contains, and only emits a
 *     RECORD/STATE pair for a stream if it is present in `requested` — so a
 *     scoped-out stream produces neither a PROGRESS line nor a RECORD for
 *     itself, exactly like a real connector honoring `START.scope`.
 *   - `--seed-last-state` round-trip: each stream's committed STATE cursor
 *     is `{ seen: <incoming cursor's "seen" + 1> }` (0 if no incoming
 *     state for that stream) — so a second run seeded from the first run's
 *     `last-state.json` commits a strictly incremented cursor, proving the
 *     seeded value actually reached `ctx.state` and was not just ignored.
 *
 * NOT registered in src/orchestrator.ts — fixture-only, never a production
 * connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if ((stream === "items" || stream === "extras") && typeof data.id === "string") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "expected string id" }] };
};

function incomingSeen(cursor: unknown): number {
  if (cursor && typeof cursor === "object" && typeof (cursor as { seen?: unknown }).seen === "number") {
    return (cursor as { seen: number }).seen;
  }
  return 0;
}

runConnector({
  name: "connector-dev-scope-state-fixture",
  validateRecord,
  async collect({ emit, emitRecord, requested, state }) {
    const requestedNames = [...requested.keys()].sort((a, b) => a.localeCompare(b));
    await emit({ type: "PROGRESS", stream: "items", message: `requested streams: ${requestedNames.join(",")}` });

    for (const stream of ["items", "extras"] as const) {
      if (!requested.has(stream)) {
        continue;
      }
      const nextSeen = incomingSeen(state[stream]) + 1;
      await emitRecord(stream, { id: `${stream}-${String(nextSeen)}` });
      await emit({ type: "STATE", stream, cursor: { seen: nextSeen } });
    }
  },
});
