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
// HOW THE SYNC ACTIONS MAP ONTO CG
//
// When this adapter was first written CG had no incremental sync at all, and
// `syncAgain` plus the cursor argument of `readPage` returned HTTP 501 without
// touching the fixture — the honest report of a client that did not implement
// the behaviour. CG now does (`sync=incremental` and `cursor` on the read
// route), so those actions drive it for real.
//
// The mapping is not one-to-one with the reference adapter, because CG holds
// the sync position server-side. A builder never sees or supplies a
// `changes_since` value: it asks for an incremental read and CG sends whatever
// position it stored for that connection and stream. So:
//
//   syncOnce(stream)   -> sync=restart: read the stream whole ignoring any
//                         stored position, then record where it ended. That is
//                         what "initial sync" means for a client keeping the
//                         position server-side, and it is what makes the cases
//                         independent — under plain `incremental`, a case's
//                         syncOnce would resume from the position the PREVIOUS
//                         case left behind and would not be an initial sync.
//   syncAgain(stream)  -> sync=incremental. CG holds the `next_changes_since`
//                         the first sync's terminal page carried, and sends it.
//   readPage(s, c)     -> scope read with `cursor=c` forwarded opaquely.
//
// `authorize` still returns 501: CG performs its authorization handshake
// during the connect flow, before a grant exists, which is the state this
// adapter starts after. That remains a real gap in what this channel can
// observe, not a CG defect — see the receipt.

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
 * there is no route to ask. Now used only by `authorize`.
 */
export const CG_ACTION_UNSUPPORTED = {
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
async function readScope(
  descriptor: VanaClientTargetDescriptor,
  stream: string,
  options: { readonly cursor?: string; readonly sync?: "incremental" | "restart" } = {}
): Promise<ClientActionResult> {
  const url = new URL(`/api/v1/connections/${encodeURIComponent(descriptor.connectionId)}/data`, descriptor.cgOrigin);
  url.searchParams.set("scope", stream);
  if (options.cursor !== undefined) {
    url.searchParams.set("cursor", options.cursor);
  }
  if (options.sync !== undefined) {
    url.searchParams.set("sync", options.sync);
  }

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
  // `resourceServerCode`/`resourceServerType` are the Section 8 identifiers CG
  // received, forwarded unexamined. Read FIRST because the clauses under test
  // are about what the RESOURCE SERVER said; `envelope.error` is CG's own
  // vocabulary for the same refusal (`pdpp_read_failed`), which is the right
  // fallback only for a refusal CG decided locally and no RS ever saw.
  return {
    errorCode: envelope.resourceServerCode ?? nested.code ?? envelope.code ?? envelope.error,
    errorType: envelope.resourceServerType ?? nested.type ?? envelope.type,
    ok: false,
    status: response.status,
  };
}

/**
 * A read plus the settle the fixture log needs.
 *
 * CG's route finalizes usage AFTER the upstream read returns, so a case that
 * inspects the fixture log the instant this resolves can otherwise race a
 * request CG has already sent but not yet finished accounting for.
 */
async function syncedRead(
  descriptor: VanaClientTargetDescriptor,
  stream: string,
  options: { readonly cursor?: string; readonly sync?: "incremental" | "restart" }
): Promise<ClientActionResult> {
  const result = await readScope(descriptor, stream, options);
  await delay(0);
  return result;
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
    authorize: async (_selection: ClientSelection) => CG_ACTION_UNSUPPORTED,

    fixture,

    /**
     * A page cursor, forwarded through CG's read route. CG hands it to the
     * resource server byte for byte and never parses or constructs one, which
     * is what clause 8.9-1 observes in the fixture log.
     */
    readPage: async (stream, cursor) => await syncedRead(descriptor, stream, cursor === undefined ? {} : { cursor }),

    /**
     * A follow-up incremental sync. Identical to `syncOnce` on the wire,
     * because the sync position is CG's to hold: the builder asks for an
     * incremental read and CG sends the `next_changes_since` the previous
     * sync's terminal page carried. A builder never constructs one.
     */
    syncAgain: async (stream) => await syncedRead(descriptor, stream, { sync: "incremental" }),

    /**
     * The initial sync of the stream. `restart`, not `incremental`: CG keeps
     * the sync position server-side and it survives between cases, so a plain
     * incremental read here would resume from whatever the previous case left
     * behind rather than starting fresh. `restart` reads the stream whole and
     * records where it ended, which is exactly what an initial sync is.
     */
    syncOnce: async (stream) => await syncedRead(descriptor, stream, { sync: "restart" }),
  };
}
