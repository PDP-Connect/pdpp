// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The null oracle for the client channel.
//
// Every client case observes the fixture's request log. A case that reads
// that log with optional chaining can be satisfied by ABSENCE — `undefined`
// compares equal to the "no cursor was sent" value it is looking for — and so
// would pass a client that never made the request at all. That is the worst
// possible false pass: the less a client does, the more conformant it looks.
//
// The paired defect receipts in client-conformance.test.ts cannot catch it,
// because every injected defect still SENDS something. This test supplies the
// one client they cannot: one that sends nothing. No case may pass it.
//
// Found by running Vana Context Gateway as a client under test: CG implements
// no incremental sync, so its adapter makes no follow-up request, and clause
// 8.9-12 passed vacuously.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ClientUnderTest, startClientFixture } from "../src/harness/client-adapter.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import { CLIENT_CASES } from "../src/tests/client.ts";

/** A client that performs no action and therefore sends no request. */
function silentClient(fixture: Awaited<ReturnType<typeof startClientFixture>>): ClientUnderTest {
  const refused = async () => ({ ok: false as const, status: 501 });
  return {
    authorize: refused,
    fixture,
    readPage: refused,
    syncAgain: refused,
    syncOnce: refused,
  };
}

describe("no client case can be satisfied by the absence of a request", () => {
  it("fails or skips every case against a client that sends nothing", async () => {
    const fixture = await startClientFixture();
    try {
      const context = { ...makeContext(new ReferenceTargetAdapter(), []), client: silentClient(fixture) };
      const passed: string[] = [];
      for (const conformanceCase of CLIENT_CASES) {
        // Sequential for the same reason runCases is: the cases share one
        // fixture and read its request log by absolute offset.
        // biome-ignore lint/performance/noAwaitInLoops: cases share one fixture's request log and must not interleave.
        const result = await runCase(conformanceCase, context);
        if (result.outcome === "pass") {
          passed.push(conformanceCase.caseId);
        }
      }
      assert.deepEqual(
        passed,
        [],
        `These cases passed a client that never sent a request, so they are satisfied by absence: ${passed.join(", ")}`
      );
    } finally {
      await fixture.close();
    }
  });
});
