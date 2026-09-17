// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Client conformance cases against Core Section 9 "Client conformance" (CL-1
// through CL-8).
//
// Every other role file in this directory drives an HTTP endpoint the suite
// itself exposes to or receives from a target: for AS and RS, `adapter.baseUrl`
// IS the implementation under test, and the case sends it a request and reads
// the response. The client role inverts that shape. Core Section 9's client
// requirements constrain a piece of software that INITIATES requests — a sync
// agent, a companion app, an importer — and there is no such thing as
// "GET-ing" a client's compliance. The suite would need to sit in the loop as
// the AS and RS the client under test talks to, capture the requests that
// client makes, and inspect the choices it made in response to deliberately
// awkward but spec-legal server behavior (a 410 cursor_expired, an unrecognized
// error code, a grant carrying `source.kind: "connector"`).
//
// `TargetAdapter` (harness/adapter.ts) has no hook for that. It models a
// target as something the suite calls INTO over HTTP (`baseUrl`, `issueGrant`,
// `ownerToken`, ...) — every method exists to let the suite act as a client
// against an AS or RS, never to let the suite observe a client's behavior.
// There is no `submitSelectionRequest`, no `driveIncrementalSync`, no captured
// request log, no way to hand the client-under-test a crafted response and ask
// what it did next. Building one is a real design problem (Section 9's client
// items are behavioral properties of a running agent, not a wire contract a
// suite can probe from outside without the target's cooperation) and is out of
// scope for this file: it would require a new adapter method per requirement,
// which is a harness change, not a test-authoring one.
//
// So every CL case below is `skip`, stating precisely the hook that does not
// exist. This is not a placeholder or a shortcut: it is the honest position
// given the current adapter surface, and it is what keeps the suite's
// tested/applicable coverage fraction meaningful. A suite that fabricated
// passes for the client role — for instance by testing properties of its OWN
// reference HTTP client rather than the target's — would be asserting
// conformance of code that is not the thing under test. That is worse than
// reporting zero: it would let a client implementation claim CL coverage it
// never earned.
//
// CL-6 (retention) and CL-8 (provenance policy) are additionally not
// black-box observable even in principle from outside the client process:
// both are about what the client does internally with data already delivered
// (deletes it on schedule; branches local policy on `source.kind`), which
// requires instrumentation of the client's own storage or policy engine, not
// just a capture of its wire traffic.

// biome-ignore-all lint/suspicious/useAwait: ConformanceCase.run is async by contract; these cases return a verdict without I/O.

import { type ConformanceCase, skip } from "../harness/runner.ts";

export const CLIENT_CASES: readonly ConformanceCase[] = [
  // ---------------------------------------------------------------- CL-1 ---
  {
    caseId: "CL-1/authorization-details-envelope",
    requirementId: "CL-1",
    assertion: "The client submits selection requests using the RFC 9396 `authorization_details` envelope.",
    async run() {
      return skip(
        "No adapter hook captures the selection request a client-under-test sends to an authorization server; verifying the RFC 9396 envelope shape requires a captured-request hook this version's TargetAdapter does not define."
      );
    },
  },

  // ---------------------------------------------------------------- CL-2 ---
  {
    caseId: "CL-2/uses-access-tokens-not-raw-grants",
    requirementId: "CL-2",
    assertion: "The client authenticates to the resource server with an access token, never a raw grant.",
    async run() {
      return skip(
        "No adapter hook captures the Authorization header a client-under-test sends to a resource server; distinguishing an access token from a raw grant on the wire requires a captured-request hook this version's TargetAdapter does not define."
      );
    },
  },

  // ---------------------------------------------------------------- CL-3 ---
  {
    caseId: "CL-3/cursor-and-changes-since-distinct-token-spaces",
    requirementId: "CL-3",
    assertion: "The client never submits a `next_cursor` value as a `changes_since` parameter.",
    async run() {
      return skip(
        "Verifying this requires observing the client-under-test's own outgoing requests across a session (to catch it reusing a next_cursor value as changes_since); this version's TargetAdapter exposes no way to drive a client-under-test's sync loop or capture what it sends, so the property is not observable from outside the client process."
      );
    },
  },

  // ---------------------------------------------------------------- CL-4 ---
  {
    caseId: "CL-4/stores-next-changes-since-for-next-session",
    requirementId: "CL-4",
    assertion:
      "A client performing incremental sync stores `next_changes_since` from the terminal page and reuses it in the next sync session.",
    async run() {
      return skip(
        "Verifying persistence across sessions requires starting and stopping the client-under-test's sync process and inspecting what token it presents on the second run; this version's TargetAdapter has no method to drive a client-under-test through two sync sessions."
      );
    },
  },

  // ---------------------------------------------------------------- CL-5 ---
  {
    caseId: "CL-5/full-resync-on-cursor-expired",
    requirementId: "CL-5",
    assertion:
      "On HTTP 410 `cursor_expired`, the client performs a full re-sync rather than retrying the expired cursor.",
    async run() {
      return skip(
        "Testing this needs the suite to act as the resource server the client-under-test is syncing against, return 410 cursor_expired, and observe whether the client's NEXT request retries the same cursor or restarts without one; this version's TargetAdapter gives the suite no way to receive requests from a client-under-test, only to send requests to a server-under-test."
      );
    },
  },

  // ---------------------------------------------------------------- CL-6 ---
  {
    caseId: "CL-6/honors-retention-commitments",
    requirementId: "CL-6",
    assertion: "The client honors the retention policy declared in its grant.",
    async run() {
      return skip(
        "Retention is an internal storage-lifecycle property of the client-under-test (does it delete data on schedule), not a wire behavior; it is not black-box observable from HTTP traffic at all, and would need an adapter hook into the client's own storage state that this version does not define."
      );
    },
  },

  // ---------------------------------------------------------------- CL-7 ---
  {
    caseId: "CL-7/unrecognized-error-code-treated-as-opaque",
    requirementId: "CL-7",
    assertion:
      "The client falls back to the actual HTTP status code and headers when it receives an unrecognized `error.code` or `error.type`, and does not fail to parse the response.",
    async run() {
      return skip(
        "Testing this requires the suite to act as the resource server, return a well-formed error body with a deliberately unrecognized `code` (e.g. a fictitious value alongside a real status), and then observe how the client-under-test proceeded — whether it crashed, misparsed, or correctly fell back to the status code; this version's TargetAdapter has no hook to serve responses TO a client-under-test or observe its resulting control flow, only to receive responses FROM a server-under-test."
      );
    },
  },

  // ---------------------------------------------------------------- CL-8 ---
  {
    caseId: "CL-8/reads-source-kind-before-first-use",
    requirementId: "CL-8",
    assertion:
      "Where the client has provenance-dependent local policy, it reads `source.kind` from the issued grant and applies that policy before first use of the records.",
    async run() {
      return skip(
        "`source.kind` reaches a client only via the grant the AS issued and (for a separated deployment) the RFC 7662 introspection response between AS and RS — never a client-facing HTTP surface the suite can serve or inspect from outside; and whether the client applied provenance POLICY before first use is a property of the client's internal decision logic, not its wire traffic. Neither is observable through TargetAdapter's request-response seam, and applicability itself is conditional on the client having provenance-dependent policy at all, which the adapter has no field to declare."
      );
    },
  },
];
