// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for `isNeverActivatedDraftAgedOut` (`server/ref-control.ts`),
 * the bounded age-out that stops an abandoned/superseded `local_device`
 * enrollment from reading `owner_state.resolver: "setup_in_progress"`
 * ("Finish connecting this source to start its first sync.") forever.
 *
 * Live incident this closes: a duplicate Codex CLI device enrollment
 * (`connector_instances.status === "active"`, 4 `device_source_instances`
 * rows, zero heartbeats/ingests ever) kept demanding owner attention
 * indefinitely because `ref-control.ts`'s `effectiveLifecycleStatus`
 * derivation (added by dcb557788 "fix(device-lifecycle): never-activated
 * local_device instances stay setup_pending, not settled") had no age
 * boundary — a genuinely abandoned enrollment and a 30-second-old fresh one
 * were indistinguishable. This function is the pure boundary check; its
 * wiring into `effectiveLifecycleStatus` is covered end-to-end by
 * `device-exporter-routes.test.ts`'s activation-lifecycle suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isNeverActivatedDraftAgedOut } from "../server/ref-control.ts";

const ENROLLED_AT = "2026-08-01T00:00:00.000Z";

test("isNeverActivatedDraftAgedOut: undefined createdAt fails closed (never ages out)", () => {
  assert.equal(isNeverActivatedDraftAgedOut(undefined, "2026-12-01T00:00:00.000Z"), false);
});

test("isNeverActivatedDraftAgedOut: a fresh enrollment (minutes old) is not aged out", () => {
  assert.equal(isNeverActivatedDraftAgedOut(ENROLLED_AT, "2026-08-01T00:05:00.000Z"), false);
});

test("isNeverActivatedDraftAgedOut: just under the 72h boundary is not aged out", () => {
  assert.equal(isNeverActivatedDraftAgedOut(ENROLLED_AT, "2026-08-03T23:59:59.000Z"), false);
});

test("isNeverActivatedDraftAgedOut: just past the 72h boundary is aged out", () => {
  assert.equal(isNeverActivatedDraftAgedOut(ENROLLED_AT, "2026-08-04T00:00:01.000Z"), true);
});

test("isNeverActivatedDraftAgedOut: an abandoned enrollment weeks old is aged out", () => {
  assert.equal(isNeverActivatedDraftAgedOut(ENROLLED_AT, "2026-08-20T00:00:00.000Z"), true);
});

test("isNeverActivatedDraftAgedOut: an unparseable createdAt fails closed rather than throwing", () => {
  assert.equal(isNeverActivatedDraftAgedOut("not-a-date", "2026-12-01T00:00:00.000Z"), false);
});

test("isNeverActivatedDraftAgedOut: an unparseable nowIso fails closed rather than throwing", () => {
  assert.equal(isNeverActivatedDraftAgedOut(ENROLLED_AT, "not-a-date"), false);
});
