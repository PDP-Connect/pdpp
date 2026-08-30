// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import { establishSession, type ProbeSessionArgs, type SessionEstablishArgs } from "./session-establish.ts";
import { TerminalError } from "./terminal-error.ts";

const FAKE_CONTEXT = {} as BrowserContext;
const FAKE_PAGE = {} as Page;

function baseArgs(overrides: Partial<SessionEstablishArgs> = {}): SessionEstablishArgs {
  return {
    assist: async () => "",
    capture: null,
    checkpoint: async () => {
      /* no-op */
    },
    completeAssistance: async () => {
      /* no-op */
    },
    context: FAKE_CONTEXT,
    name: "venmo",
    page: FAKE_PAGE,
    progress: async () => {
      /* no-op */
    },
    retryablePattern: /never_matches/,
    sendInteraction: async () => ({
      request_id: "req-1",
      status: "success" as const,
      type: "INTERACTION_RESPONSE" as const,
    }),
    ...overrides,
  };
}

// Regression for production run_1788030841840 / run_1788061976811: an
// assisted-login handoff completed with no owner interaction fired, and
// `ensureSession` returned normally without ever proving the session was
// live. The first thing to discover the session was dead was `collect()`'s
// own `/account` call, 401ing as `venmo_session_expired` — three owner
// challenges had already been spent by the time this was diagnosed. A
// connector supplying `probeSession` alongside `ensureSession` must have that
// claim checked BEFORE collect() ever starts.
test("establishSession: an ensureSession claim is verified against probeSession, and a dead session fails closed before collect()", async () => {
  const probeCalls: string[] = [];
  await assert.rejects(
    establishSession(
      {
        ensureSession: async () => {
          /* claims success but never actually authenticated */
        },
        // biome-ignore lint/suspicious/useAwait: mirrors the real probeSession signature
        probeSession: async (_args: ProbeSessionArgs) => {
          probeCalls.push("probe");
          return false;
        },
      },
      baseArgs()
    ),
    (err: unknown) => {
      assert.ok(err instanceof TerminalError);
      assert.match(err.message, /venmo_session_unverified_after_establish/);
      assert.equal(err.retryable, false, "an unverified claim must not be retried against the same handoff");
      return true;
    }
  );
  assert.deepEqual(probeCalls, ["probe"], "probeSession must be called exactly once to check the claim");
});

test("establishSession: a live session verified by probeSession resolves normally", async () => {
  await assert.doesNotReject(
    establishSession(
      {
        ensureSession: async () => {
          /* claims success, and IS live */
        },
        probeSession: async (_args: ProbeSessionArgs) => true,
      },
      baseArgs()
    )
  );
});

test("establishSession: a connector with no probeSession is unaffected — the ensureSession claim is trusted as before", async () => {
  let ensureSessionCalled = false;
  await assert.doesNotReject(
    establishSession(
      {
        // biome-ignore lint/suspicious/useAwait: mirrors ensureSession returning normally
        ensureSession: async () => {
          ensureSessionCalled = true;
        },
        probeSession: undefined,
      },
      baseArgs()
    )
  );
  assert.equal(ensureSessionCalled, true);
});

// Independent review of an earlier version of this file
// (PR238-NEXT-TRAIN-CONSTITUENTS-INDEPENDENT-R1-0830.md §8, P1 "a
// verification transport fault remains retryable"): a THROWN probeSession
// fault (e.g. Venmo's own venmo_probe_transport_error, which is deliberately
// RETRYABLE pre-submit) previously escaped verifyEstablishedSession as a
// plain Error, reached the runtime's generic retryablePattern classification,
// and could redispatch the run — resubmitting a credential or repeating an
// owner challenge that had already happened. A thrown post-establish
// verification fault must be forced non-retryable exactly like a `false`
// result, never left to the connector's retryablePattern.
test("establishSession: a THROWN post-establish probeSession fault is forced non-retryable, even when its message matches the connector's own retryablePattern", async () => {
  await assert.rejects(
    establishSession(
      {
        ensureSession: async () => {
          /* claims success but never actually authenticated */
        },
        // biome-ignore lint/suspicious/useAwait: throws synchronously to mirror a transport blip hitting the verifier itself
        probeSession: async (_args: ProbeSessionArgs) => {
          // Deliberately named to match a connector's retryablePattern (e.g.
          // Venmo's VENMO_RETRYABLE_PATTERN matches "venmo_probe_transport_error")
          // — this must NOT be enough to make the run retryable here.
          throw new Error("venmo_probe_transport_error: socket hang up");
        },
      },
      baseArgs({ retryablePattern: /venmo_probe_transport_error/ })
    ),
    (err: unknown) => {
      assert.ok(err instanceof TerminalError);
      assert.match(err.message, /venmo_session_unverified_after_establish/);
      assert.equal(
        err.retryable,
        false,
        "a thrown verification fault after owner/credential work must never be retryable, regardless of the connector's retryablePattern"
      );
      assert.ok(err.cause instanceof Error, "the underlying transport fault must stay attached for diagnostics");
      return true;
    }
  );
});

test("establishSession: an ensureSession throw is classified through the ordinary retryablePattern path, never through probeSession verification", async () => {
  let probeCalled = false;
  await assert.rejects(
    establishSession(
      {
        // biome-ignore lint/suspicious/useAwait: throws synchronously to mirror a connector ensureSession fault
        ensureSession: async () => {
          throw new Error("venmo_session_expired: dead");
        },
        // biome-ignore lint/suspicious/useAwait: mirrors the real probeSession signature; must never be reached here
        probeSession: async (_args: ProbeSessionArgs) => {
          probeCalled = true;
          return true;
        },
      },
      baseArgs()
    ),
    (err: unknown) => {
      assert.ok(err instanceof TerminalError);
      assert.match(err.message, /venmo_session_failed/);
      return true;
    }
  );
  assert.equal(probeCalled, false, "a thrown ensureSession error must not fall through to verification");
});
