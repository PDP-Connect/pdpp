// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { activateDraftConnection } from "../server/index.ts";

// On a lost promotion race (`promoted: false`), the caller must return null
// without calling the schedule attacher. The store-level guard itself is
// proven in test/setup-binding-promotion.test.ts.

function fakeStore(overrides: {
  current: { status?: string; sourceBinding?: unknown } | null;
  promoted: boolean;
  promotedInstance?: unknown;
}) {
  return {
    activateDraft: () => ({ status: "active" }),
    get: () => overrides.current,
    promoteSetupBinding: () => ({
      instance: overrides.promotedInstance ?? { status: "active" },
      promoted: overrides.promoted,
    }),
  };
}

test("lost race: promoted=false returns null and never attaches a schedule", async () => {
  const store = fakeStore({
    current: { sourceBinding: { kind: "browser_enrollment_shell" }, status: "draft" },
    promoted: false,
  });
  let attachCalled = false;
  const attachSchedule = (instance: unknown) => {
    attachCalled = true;
    return Promise.resolve(instance);
  };

  const result = await activateDraftConnection("cin_race", store, attachSchedule);

  assert.equal(result, null, "a lost race returns null");
  assert.equal(attachCalled, false, "a lost race never attaches an activation schedule");
});

test("won race: promoted=true attaches a schedule and returns its result", async () => {
  const promotedInstance = { connectorInstanceId: "cin_won", status: "active" };
  const store = fakeStore({
    current: { sourceBinding: { kind: "browser_enrollment_shell" }, status: "draft" },
    promoted: true,
    promotedInstance,
  });
  let attachedWith: unknown;
  const attachSchedule = (instance: unknown) => {
    attachedWith = instance;
    return Promise.resolve("schedule_result");
  };

  const result = await activateDraftConnection("cin_won", store, attachSchedule);

  assert.equal(result, "schedule_result", "a won race returns the schedule attacher's result");
  assert.deepEqual(attachedWith, promotedInstance, "the schedule attacher receives the promoted instance");
});

test("non-setup binding: falls through to plain activateDraft and attaches a schedule", async () => {
  const store = fakeStore({
    current: { sourceBinding: { kind: "account" }, status: "draft" },
    promoted: false,
  });
  let attachCalled = false;
  const attachSchedule = (instance: unknown) => {
    attachCalled = true;
    return Promise.resolve(instance);
  };

  const result = await activateDraftConnection("cin_plain", store, attachSchedule);

  assert.deepEqual(result, { status: "active" }, "falls through to activateDraft's result");
  assert.equal(attachCalled, true, "the plain-activation path still attaches a schedule");
});

test("already-active row: falls through to activateDraft (no-op) without ever calling promoteSetupBinding", async () => {
  let promoteCalled = false;
  const store = {
    activateDraft: () => ({ status: "active" }),
    get: () => ({ sourceBinding: { kind: "browser_enrollment_shell" }, status: "active" }),
    promoteSetupBinding: () => {
      promoteCalled = true;
      return { instance: null, promoted: false };
    },
  };

  await activateDraftConnection("cin_already_active", store, (instance) => Promise.resolve(instance));

  assert.equal(promoteCalled, false, "an already-active row never reaches promoteSetupBinding");
});
