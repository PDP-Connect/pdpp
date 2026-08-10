// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { friendsSchema, profileSchema, transactionsSchema, validateRecord } from "./schemas.ts";

const PROFILE_RECORD = {
  id: "1234567890123456789",
  username: "jane_doe",
  first_name: "Jane",
  last_name: "Doe",
  display_name: "Jane Doe",
  phone: "+15555550100",
  profile_picture_url: "https://pics.venmo.com/abc.jpg",
  about: "coffee enthusiast",
  date_joined: "2015-03-04T18:22:01Z",
  is_business: false,
};

const FRIEND_RECORD = {
  id: "9876543210987654321",
  username: "john_smith",
  first_name: "John",
  last_name: "Smith",
  display_name: "John Smith",
  phone: null,
  profile_picture_url: null,
  about: null,
  date_joined: "2014-11-02T09:00:00Z",
  is_group: false,
  is_active: true,
};

const TRANSACTION_RECORD = {
  id: "4242424242424242424",
  payment_id: "1111111111111111111",
  date_created: "2026-07-15T14:30:00Z",
  date_updated: "2026-07-15T14:30:05Z",
  date_completed: "2026-07-15T14:30:05Z",
  payment_type: "pay",
  amount_cents: 2500,
  audience: "private",
  status: "settled",
  note: "lunch",
  device_used: "iPhone",
  actor: { id: "1234567890123456789", username: "jane_doe", display_name: "Jane Doe" },
  target: { id: "9876543210987654321", username: "john_smith", display_name: "John Smith" },
  is_owner_actor: true,
};

test("profile schema accepts a representative record", () => {
  const result = profileSchema.safeParse(PROFILE_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema accepts all-null optional fields", () => {
  const result = profileSchema.safeParse({
    ...PROFILE_RECORD,
    username: null,
    first_name: null,
    last_name: null,
    display_name: null,
    phone: null,
    profile_picture_url: null,
    about: null,
    date_joined: null,
    is_business: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema rejects a non-numeric id", () => {
  assert.equal(profileSchema.safeParse({ ...PROFILE_RECORD, id: "user_123" }).success, false);
});

test("friends schema accepts a representative record", () => {
  const result = friendsSchema.safeParse(FRIEND_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("friends schema accepts a group entry", () => {
  const result = friendsSchema.safeParse({ ...FRIEND_RECORD, is_group: true, is_active: null });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("transactions schema accepts a representative pay record", () => {
  const result = transactionsSchema.safeParse(TRANSACTION_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("transactions schema accepts a charge with null counterparty (deleted/unavailable user)", () => {
  const result = transactionsSchema.safeParse({
    ...TRANSACTION_RECORD,
    payment_type: "charge",
    target: null,
    is_owner_actor: false,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("transactions schema rejects an unmodeled payment_type discriminator by itself (single-option literal, not vocabulary)", () => {
  // payment_type is a 2-member z.enum ("pay"|"charge"); an unmodeled third
  // value IS open-vocabulary drift and is retained (not rejected) by
  // validateRecord — see the retention test below. Direct schema.safeParse
  // (no retention layer) still reports failure, which is what this asserts.
  assert.equal(transactionsSchema.safeParse({ ...TRANSACTION_RECORD, payment_type: "refund" }).success, false);
});

test("transactions schema rejects a missing amount_cents", () => {
  const { amount_cents: _omit, ...withoutAmount } = TRANSACTION_RECORD;
  assert.equal(transactionsSchema.safeParse(withoutAmount).success, false);
});

test("validateRecord retains an unmodeled status value as vocabulary drift, not a hard skip", () => {
  const result = validateRecord("transactions", { ...TRANSACTION_RECORD, status: "disputed" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal((result.data as { status: string }).status, "disputed", "the original value must survive verbatim");
    assert.ok(
      result.anomalies && result.anomalies.length > 0,
      "drift must be reported as an anomaly, not silently swallowed"
    );
  }
});

test("validateRecord routes by stream and passes unknown streams through", () => {
  assert.equal(validateRecord("profile", PROFILE_RECORD).ok, true);
  assert.equal(validateRecord("friends", FRIEND_RECORD).ok, true);
  assert.equal(validateRecord("transactions", TRANSACTION_RECORD).ok, true);
  assert.equal(validateRecord("payment_methods", { id: "1" }).ok, true);
});
