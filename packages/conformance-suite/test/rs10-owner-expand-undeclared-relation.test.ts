// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// RS-10/owner-expand-undeclared-relation-rejected's own oracle-discrimination
// proof, against a real HTTP server (see test/oracle-discrimination.test.ts
// for the pattern this follows).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SeededStream } from "../src/harness/adapter.ts";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { DEFAULT_FIXTURES, ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import { declaredRelationNames, RESOURCE_SERVER_CASES } from "../src/tests/resource-server.ts";

const SERVED_INSTEAD_OF_REJECTED_PATTERN = /served \(200\) instead of rejected/;

// The exact synthetic name the case tries first when it believes nothing is
// declared. A fixture that genuinely declares a relation under this name
// makes the mismatch control below observable.
const CANDIDATE_SEED_NAME = "pdpp_conformance_undeclared_relation__c7e2f9a1";

const CASE_ID = "RS-10/owner-expand-undeclared-relation-rejected";
const maybeCase = RESOURCE_SERVER_CASES.find((c) => c.caseId === CASE_ID);
assert.ok(maybeCase, `No case with id ${CASE_ID}`);
const theCase = maybeCase;

async function run(defects: readonly ("ignore-owner-expand-undeclared-relation" | "deny-owner-records")[]) {
  const adapter = new ReferenceTargetAdapter(undefined, new Set(defects));
  const { streams } = await adapter.setup();
  try {
    return await runCase(theCase, makeContext(adapter, streams));
  } finally {
    await adapter.teardown();
  }
}

describe("RS-10/owner-expand-undeclared-relation-rejected", () => {
  it("passes against a clean reference target: valid read then undeclared expand both behave", async () => {
    const result = await run([]);
    assert.equal(result.outcome, "pass", result.detail ?? "unexpected non-pass");
  });

  it("fails a server that silently serves an undeclared expand[] and returns 200", async () => {
    const result = await run(["ignore-owner-expand-undeclared-relation"]);
    assert.equal(result.outcome, "fail", `expected fail, got ${result.outcome}: ${result.detail ?? ""}`);
    assert.match(result.detail ?? "", SERVED_INSTEAD_OF_REJECTED_PATTERN);
  });

  it("fails a server that denies record reads despite a valid owner token (deny-everything cannot pass)", async () => {
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

  it("consults the ACTUAL returned metadata, not a stale fixture expectation, when choosing the undeclared relation name", async () => {
    // A real relationship declared under the case's own first-choice synthetic
    // name. If the oracle picked its undeclared-relation candidate from
    // `stream.expectedOwnerMetadata` (the fixture's retained expectation)
    // instead of the live metadata response, faking that expectation to say
    // "nothing is declared" would make it try this name first — which the
    // real, unmodified server genuinely serves, proving the oracle read stale
    // data. Consulting the live response instead must skip this name and
    // succeed on a truly undeclared one.
    const [base, ...rest] = DEFAULT_FIXTURES;
    assert.ok(base, "DEFAULT_FIXTURES must have at least one stream");
    const fixtures = [
      { ...base, relationships: [{ id: CANDIDATE_SEED_NAME, targetStream: base.name, type: "has_many" }] },
      ...rest,
    ];
    const adapter = new ReferenceTargetAdapter(fixtures);
    const originalSetup = adapter.setup.bind(adapter);
    adapter.setup = async () => {
      const { streams } = await originalSetup();
      const mismatched: readonly SeededStream[] = streams.map((s) =>
        s.name === base.name ? { ...s, expectedOwnerMetadata: { ...s.expectedOwnerMetadata, relationships: [] } } : s
      );
      return { streams: mismatched };
    };
    const { streams } = await adapter.setup();
    try {
      const result = await runCase(theCase, makeContext(adapter, streams));
      assert.equal(result.outcome, "pass", result.detail ?? "unexpected non-pass");
    } finally {
      await adapter.teardown();
    }
  });
});

describe("owner expansion metadata parsing", () => {
  it("rejects malformed envelopes and capability containers", () => {
    for (const body of [
      null,
      {},
      [],
      { object: "list" },
      { object: "stream_metadata", query: "invalid" },
      { object: "stream_metadata", query: [] },
      { object: "stream_metadata", relationships: {} },
      { object: "stream_metadata", query: { expand: {} } },
    ]) {
      assert.ok("malformed" in declaredRelationNames(body), JSON.stringify(body));
    }
  });

  it("uses the protocol name when unrelated id metadata is also present", () => {
    const result = declaredRelationNames({
      object: "stream_metadata",
      relationships: [{ name: CANDIDATE_SEED_NAME, id: "unrelated-id" }],
      query: { expand: [{ name: "another_relation" }] },
    });
    assert.ok("declared" in result);
    assert.ok(result.declared.has(CANDIDATE_SEED_NAME));
    assert.ok(result.expandable.has("another_relation"));
  });

  it("does not treat structural relationships as declared expansion", () => {
    const result = declaredRelationNames({ object: "stream_metadata", relationships: [{ name: "messages" }] });
    assert.ok("declared" in result);
    assert.ok(result.declared.has("messages"));
    assert.equal(result.expandable.size, 0);
  });
});
