// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// RS-10/unsupported-bracketed-shape-rejected's own oracle-discrimination
// proof, against a real HTTP server (see test/oracle-discrimination.test.ts
// for the pattern this follows).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import { RESOURCE_SERVER_CASES } from "../src/tests/resource-server.ts";

const SERVED_INSTEAD_OF_REJECTED_PATTERN = /served \(200\) instead of rejected/;

const CASE_ID = "RS-10/unsupported-bracketed-shape-rejected";
const maybeCase = RESOURCE_SERVER_CASES.find((c) => c.caseId === CASE_ID);
assert.ok(maybeCase, `No case with id ${CASE_ID}`);
const theCase = maybeCase;

async function run(defects: readonly ("ignore-unknown-params" | "deny-owner-records")[]) {
  const adapter = new ReferenceTargetAdapter(undefined, new Set(defects));
  const { streams } = await adapter.setup();
  try {
    return await runCase(theCase, makeContext(adapter, streams));
  } finally {
    await adapter.teardown();
  }
}

describe("RS-10/unsupported-bracketed-shape-rejected", () => {
  it("passes against a clean reference target on both client-token and owner-token surfaces", async () => {
    const result = await run([]);
    assert.equal(result.outcome, "pass", result.detail ?? "unexpected non-pass");
  });

  it("fails a server that silently ignores limit[x] and serves 200", async () => {
    const result = await run(["ignore-unknown-params"]);
    assert.equal(result.outcome, "fail", `expected fail, got ${result.outcome}: ${result.detail ?? ""}`);
    assert.match(result.detail ?? "", SERVED_INSTEAD_OF_REJECTED_PATTERN);
  });

  it("fails a server that denies every owner record read, including the positive read (deny-everything cannot pass)", async () => {
    const result = await run(["deny-owner-records"]);
    assert.equal(result.outcome, "fail", `expected fail, got ${result.outcome}: ${result.detail ?? ""}`);
  });

  it("fails when the issued client-token grant does not actually work (positive read denied)", async () => {
    const adapter = new ReferenceTargetAdapter();
    const originalIssueGrant = adapter.issueGrant.bind(adapter);
    adapter.issueGrant = async (request) => {
      const grant = await originalIssueGrant(request);
      return grant ? { ...grant, accessToken: `${grant.accessToken}-invalid-suffix` } : grant;
    };
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(theCase, makeContext(adapter, streams));
      assert.equal(result.outcome, "fail", `expected fail, got ${result.outcome}: ${result.detail ?? ""}`);
    } finally {
      await adapter.teardown();
    }
  });

  it("reports incomplete (skip) rather than pass when owner tokens are declared but the adapter produces none", async () => {
    const adapter = new ReferenceTargetAdapter();
    adapter.ownerToken = async () => null;
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(theCase, makeContext(adapter, streams));
      assert.equal(result.outcome, "skip", `expected skip, got ${result.outcome}`);
    } finally {
      await adapter.teardown();
    }
  });
});
