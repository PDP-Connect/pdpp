// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  browserConfigPreservationFor,
  browserSurfacePolicyFor,
  connectorRetainsSurfaceProcess,
  connectorUsesPhaseScopedSurface,
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

// I6: run-level connectors (surfaceScope default/"run") must stay unchanged
// by the bounded phase-lease feature, and only a connector explicitly
// declaring surfaceScope: "phase" is treated as phase-scoped.
test("surfaceScope: chatgpt is run-scoped (default), slack is phase-scoped, an unknown connector has no scope", () => {
  assert.equal(browserSurfacePolicyFor("chatgpt")?.surfaceScope, undefined, "chatgpt relies on the run default");
  assert.equal(browserSurfacePolicyFor("slack")?.surfaceScope, "phase");
  assert.equal(browserSurfacePolicyFor("does-not-exist"), null);
});

test("connectorUsesPhaseScopedSurface: chatgpt=false, slack=true, unknown connector=false", () => {
  assert.equal(connectorUsesPhaseScopedSurface("chatgpt"), false);
  assert.equal(connectorUsesPhaseScopedSurface("slack"), true);
  for (const id of ["does-not-exist", "", null, undefined]) {
    assert.equal(connectorUsesPhaseScopedSurface(id), false, `${String(id)} must not be phase-scoped`);
  }
});
