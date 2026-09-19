// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// RS-10/owner-filter-unknown-field-rejected's own oracle-discrimination proof,
// against a real HTTP server (see test/oracle-discrimination.test.ts for the
// pattern this follows).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import { RESOURCE_SERVER_CASES } from "../src/tests/resource-server.ts";

const SERVED_INSTEAD_OF_REJECTED_PATTERN = /served \(200\) instead of rejected/;

const CASE_ID = "RS-10/owner-filter-unknown-field-rejected";
const maybeCase = RESOURCE_SERVER_CASES.find((c) => c.caseId === CASE_ID);
assert.ok(maybeCase, `No case with id ${CASE_ID}`);
const theCase = maybeCase;

async function run(defects: readonly ("ignore-owner-filter-unknown-field" | "deny-owner-records")[]) {
  const adapter = new ReferenceTargetAdapter(undefined, new Set(defects));
  const { streams } = await adapter.setup();
  try {
    return await runCase(theCase, makeContext(adapter, streams));
  } finally {
    await adapter.teardown();
  }
}

describe("RS-10/owner-filter-unknown-field-rejected", () => {
  it("passes against a clean reference target: valid read then invalid filter both behave", async () => {
    const result = await run([]);
    assert.equal(result.outcome, "pass", result.detail ?? "unexpected non-pass");
  });

  it("fails a server that silently ignores the unknown-field filter and serves 200", async () => {
    const result = await run(["ignore-owner-filter-unknown-field"]);
    assert.equal(result.outcome, "fail", `expected fail, got ${result.outcome}: ${result.detail ?? ""}`);
    assert.match(result.detail ?? "", SERVED_INSTEAD_OF_REJECTED_PATTERN);
  });

  it("fails a server that denies record reads despite a valid owner token", async () => {
    const result = await run(["deny-owner-records"]);
    assert.equal(result.outcome, "fail");
  });

  it("fails when the adapter supplies an invalid owner token", async () => {
    const adapter = new ReferenceTargetAdapter();
    const original = adapter.ownerToken.bind(adapter);
    adapter.ownerToken = async () => {
      const token = await original();
      return token ? `${token}-invalid-suffix` : token;
    };
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(theCase, makeContext(adapter, streams));
      assert.equal(result.outcome, "fail");
    } finally {
      await adapter.teardown();
    }
  });
});
