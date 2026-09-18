// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Vana Context Gateway as a ClientUnderTest.
//
// Context Gateway is a PDPP client that reads on a builder app's behalf: the
// app calls CG's public routes, and CG makes the Section 8 requests to the
// owner's Personal Server. So the client whose conformance this observes is
// CG's outbound read path, and the actions below drive it the way a builder
// app does — over CG's public HTTP surface with an API key, never by calling
// CG's internals.
//
// WHAT MAKES CG REACHABLE AS A CLIENT
//
// Batch 19 left this adapter deferred, noting it needs "a gateway binding
// that routes the client to the client fixture". That binding is a real CG
// concept, not a test seam: a `pdpp_connection_bindings` row's `resource`
// column is the RFC 9728 resource identifier CG's PdppContextClient fetches
// from. Point it at ClientFixture.url and CG's unmodified read path makes its
// requests to the fixture. No CG source is patched and no transport is
// replaced with a double; the provisioning script
// (`scripts/provision-client-target.mjs` in the Context Gateway worktree)
// seeds that row and starts a real CG server.
//
// WHAT THIS ADAPTER CANNOT DO, AND WHY THAT IS A FINDING
//
// `syncAgain` and the cursor argument of `readPage` have no CG behaviour to
// drive. CG's public read route accepts only `scope` and `fileId`; it exposes
// no `changes_since`, no cursor, and no sync-state handle. Below the route,
// `readScopeViaPdpp` drains every page and discards `next_cursor` when it is
// done, and no CG code path anywhere sets `changes_since`, reads
// `next_changes_since`, or handles a `cursor_expired` response — the strings
// appear only in type declarations and unit tests.
//
// That is a real conformance finding about CG, so this adapter reports it as
// one rather than faking the behaviour. The unsupported actions return
// `CG_INCREMENTAL_SYNC_UNSUPPORTED` (HTTP 501) without touching the fixture,
// which makes the affected cases FAIL with a reviewable receipt: the fixture's
// request log shows the follow-up request CG never sent. A case that needs a
// behaviour the client does not implement must not be able to pass.

import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ClientActionResult, ClientFixture, ClientSelection, ClientUnderTest } from "../harness/client-adapter.ts";

/**
 * What `provision-client-target.mjs` prints once Context Gateway is serving.
 * Everything here is created by that script against a throwaway database.
 */
export interface VanaClientTargetDescriptor {
  readonly apiKey: string;
  readonly cgOrigin: string;
  readonly connectionId: string;
  /** The stream the seeded grant covers; also the fixture's stream name. */
  readonly stream: string;
}

/**
 * The status this adapter returns for an action Context Gateway has no client
 * behaviour for. Not an HTTP status CG produced — CG was never asked, because
 * there is no route to ask.
 */
export const CG_INCREMENTAL_SYNC_UNSUPPORTED = {
  errorCode: "not_implemented_by_client",
  ok: false,
  status: 501,
} as const satisfies ClientActionResult;

/**
 * Read the descriptor a running provisioning script wrote.
 *
 * Kept separate from the adapter so a caller can provision once and build
 * several adapters, and so the adapter itself needs no filesystem knowledge.
 */
export async function readVanaClientTargetDescriptor(stateFile: string): Promise<VanaClientTargetDescriptor> {
  const parsed: unknown = JSON.parse(await readFile(stateFile, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${stateFile} does not hold a client-target descriptor.`);
  }
  const descriptor = parsed as Partial<VanaClientTargetDescriptor>;
  for (const field of ["apiKey", "cgOrigin", "connectionId", "stream"] as const) {
    if (typeof descriptor[field] !== "string") {
      throw new Error(`${stateFile} is missing string field "${field}".`);
    }
  }
  return descriptor as VanaClientTargetDescriptor;
}

/**
 * Ask Context Gateway to read a scope, the way a builder app's SDK call does.
 *
 * The scope is the stream name: CG's data route matches a requested scope
 * against the connection's `canonical_scopes`, and the provisioning script
 * seeds that list with the stream the grant covers.
 */
async function readScope(descriptor: VanaClientTargetDescriptor, stream: string): Promise<ClientActionResult> {
  const url = new URL(`/api/v1/connections/${encodeURIComponent(descriptor.connectionId)}/data`, descriptor.cgOrigin);
  url.searchParams.set("scope", stream);

  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${descriptor.apiKey}` },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("application/json") ? await response.json() : await response.text();

  if (response.ok) {
    return { ok: true, status: response.status };
  }

  // CG re-shapes a Personal Server refusal into its own envelope rather than
  // proxying the Section 8 body verbatim, so the code a case sees is the one
  // CG chose to surface. Reading both shapes keeps the observation honest
  // about which layer produced it.
  const envelope = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const nested =
    envelope.error && typeof envelope.error === "object" ? (envelope.error as Record<string, unknown>) : {};
  return {
    errorCode: nested.code ?? envelope.code ?? envelope.error,
    errorType: nested.type ?? envelope.type,
    ok: false,
    status: response.status,
  };
}

/**
 * Build a ClientUnderTest backed by a running Context Gateway.
 *
 * The caller owns both halves and must wire them in this order: start the
 * fixture, provision CG with `--resource <fixture.url>`, then pass both here.
 * The order is forced by CG's design — the binding's `resource` is written
 * when the grant is stored, so the fixture's URL has to exist before CG does.
 */
export function createVanaContextGatewayClientUnderTest(
  descriptor: VanaClientTargetDescriptor,
  fixture: ClientFixture
): ClientUnderTest {
  return {
    /**
     * CG performs its authorization handshake during the connect flow, before
     * a grant exists — which is exactly the state this adapter starts after.
     * Re-running it here would drive CG's consent flow, not its client read
     * path, and would need a conforming AS in front of the fixture.
     *
     * The seeded grant is nonetheless evidence for the selection-shape cases:
     * the selection CG builds is `pdpp-grant-scope.ts`'s
     * `scopeSnapshotFromSelection`, which emits `source: { id }` and stream
     * entries only. Because no request reaches the fixture, the cases that
     * read the fixture log for a selection body fail rather than pass on an
     * assumption. See the receipt's per-clause table.
     */
    authorize: async (_selection: ClientSelection) => CG_INCREMENTAL_SYNC_UNSUPPORTED,

    fixture,

    /**
     * A cursor argument has nowhere to go: CG's read route takes no cursor,
     * and `readScopeViaPdpp` drains pages internally. Passing one and reading
     * the whole stream anyway would report a cursor CG never forwarded, so a
     * cursored read is refused and an uncursored one is a real CG read.
     */
    readPage: async (stream, cursor) =>
      cursor === undefined ? await readScope(descriptor, stream) : CG_INCREMENTAL_SYNC_UNSUPPORTED,

    /**
     * Incremental sync is not implemented by Context Gateway. Returning
     * `501` without calling CG is the honest observation: the fixture log
     * will show no follow-up request, which is precisely the defect the
     * CL-3/CL-4/CL-5 cases exist to detect.
     */
    syncAgain: async (_stream) => CG_INCREMENTAL_SYNC_UNSUPPORTED,

    /**
     * The initial sync IS a plain read of the whole stream, which is what CG
     * does, so this is a real request through CG's real client path.
     */
    syncOnce: async (stream) => {
      const result = await readScope(descriptor, stream);
      // CG's route finalizes usage after the upstream read returns; a case
      // that immediately inspects the fixture log can otherwise race the
      // request CG has already sent but not yet finished accounting for.
      await delay(0);
      return result;
    },
  };
}
