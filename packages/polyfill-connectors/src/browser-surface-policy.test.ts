import assert from "node:assert/strict";
import test from "node:test";

import {
  browserConfigPreservationFor,
  browserSurfacePolicyFor,
  connectorRetainsSurfaceProcess,
} from "./browser-surface-policy.ts";

// This registry is the single source of truth binding page preservation and
// surface-process retention together. The invariant that keeps it honest:
// anything that retains its process MUST also preserve its pages (retention is
// only meaningful when auth lives in the live page/process).

test("ChatGPT preserves both pages and retains its surface process", () => {
  const policy = browserSurfacePolicyFor("chatgpt");
  assert.ok(policy);
  assert.equal(policy.preservePageOnSuccess, true);
  assert.equal(policy.preservePageOnFailure, true);
  assert.equal(policy.retainSurfaceProcess, true);
});

test("browserConfigPreservationFor spreads the page flags for the connector entry", () => {
  assert.deepEqual(browserConfigPreservationFor("chatgpt"), {
    preservePageOnSuccess: true,
    preservePageOnFailure: true,
  });
  assert.deepEqual(browserConfigPreservationFor("chase"), {});
  assert.deepEqual(browserConfigPreservationFor(null), {});
});

test("connectorRetainsSurfaceProcess is true only for registered credential-boundary connectors", () => {
  assert.equal(connectorRetainsSurfaceProcess("chatgpt"), true);
  for (const id of ["chase", "usaa", "amazon", "reddit", "", null, undefined]) {
    assert.equal(connectorRetainsSurfaceProcess(id), false, `${String(id)} must not retain`);
  }
});

test("invariant: any retained connector also preserves both pages", () => {
  for (const name of ["chatgpt"]) {
    const policy = browserSurfacePolicyFor(name);
    assert.ok(policy);
    if (policy.retainSurfaceProcess) {
      assert.equal(policy.preservePageOnSuccess, true, `${name} retains but does not preserve success page`);
      assert.equal(policy.preservePageOnFailure, true, `${name} retains but does not preserve failure page`);
    }
  }
});
