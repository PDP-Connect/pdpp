// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { dollarsToCents, profileRecord, transactionRecord, userRecord } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { VenmoStory, VenmoUser } from "./types.ts";

const RAW_USER: VenmoUser = {
  id: "1234567890123456789",
  username: "jane_doe",
  first_name: "Jane",
  last_name: "Doe",
  display_name: "Jane Doe",
  phone: "+15555550100",
  profile_picture_url: "https://pics.venmo.com/abc.jpg",
  about: "coffee enthusiast",
  date_joined: "2015-03-04T18:22:01Z",
  is_group: false,
  is_active: true,
  is_business: false,
};

test("dollarsToCents converts a float dollar amount to integer cents", () => {
  assert.equal(dollarsToCents(25), 2500);
  assert.equal(dollarsToCents(9.99), 999);
  assert.equal(dollarsToCents(-5.5), -550);
});

test("dollarsToCents rounds floating-point drift instead of truncating (25.005 -> 2501, not 2500)", () => {
  assert.equal(dollarsToCents(25.005), 2501);
});

test("dollarsToCents returns 0 for a missing or NaN amount rather than throwing", () => {
  assert.equal(dollarsToCents(null), 0);
  assert.equal(dollarsToCents(undefined), 0);
  assert.equal(dollarsToCents(Number.NaN), 0);
});

test("userRecord maps every documented field and passes the friends schema", () => {
  const record = userRecord(RAW_USER);
  assert.equal(record.id, RAW_USER.id);
  assert.equal(record.username, "jane_doe");
  assert.equal(record.is_group, false);
  assert.equal(validateRecord("friends", record).ok, true);
});

test("userRecord defaults every optional field to null, never undefined or a sentinel string", () => {
  const record = userRecord({ id: "1" });
  assert.equal(record.username, null);
  assert.equal(record.about, null);
  assert.equal(record.is_active, null);
  assert.ok(!("username" in record) || record.username === null);
});

test("profileRecord uses is_business (not is_group/is_active) and passes the profile schema", () => {
  const record = profileRecord(RAW_USER);
  assert.equal(record.is_business, false);
  assert.ok(!("is_group" in record));
  assert.ok(!("is_active" in record));
  assert.equal(validateRecord("profile", record).ok, true);
});

const RAW_PAY_STORY: VenmoStory = {
  id: "4242424242424242424",
  audience: "private",
  date_created: "2026-07-15T14:30:00Z",
  date_updated: "2026-07-15T14:30:05Z",
  type: "payment",
  app: { name: "iPhone" },
  payment: {
    id: "1111111111111111111",
    action: "pay",
    actor: { id: "1234567890123456789", username: "jane_doe", display_name: "Jane Doe" },
    target: { user: { id: "9876543210987654321", username: "john_smith", display_name: "John Smith" } },
    amount: 25,
    date_completed: "2026-07-15T14:30:05Z",
    note: "lunch",
    status: "settled",
  },
};

test("transactionRecord converts a pay story to a valid record, correctly deriving is_owner_actor", () => {
  const record = transactionRecord(RAW_PAY_STORY, "1234567890123456789");
  assert.ok(record);
  assert.equal(record?.payment_type, "pay");
  assert.equal(record?.amount_cents, 2500);
  assert.equal(record?.is_owner_actor, true, "owner is the actor (sender) on a pay story");
  assert.equal(validateRecord("transactions", record).ok, true);
});

test("transactionRecord sets is_owner_actor false when the owner is the target, not the actor", () => {
  const record = transactionRecord(RAW_PAY_STORY, "9876543210987654321");
  assert.equal(record?.is_owner_actor, false);
});

test("transactionRecord returns null for a story with no payment object (refund/transfer/top_up/etc.)", () => {
  const record = transactionRecord(
    { id: "1", date_created: "2026-01-01T00:00:00Z", type: "transfer" },
    "1234567890123456789"
  );
  assert.equal(record, null);
});

test("transactionRecord returns null for an unmodeled payment.action (not pay/charge)", () => {
  const record = transactionRecord(
    { ...RAW_PAY_STORY, payment: { ...RAW_PAY_STORY.payment, action: "refund" } },
    "1234567890123456789"
  );
  assert.equal(record, null);
});

test("transactionRecord returns null when date_created is missing (required cursor field)", () => {
  const { date_created: _omit, ...withoutDate } = RAW_PAY_STORY;
  const record = transactionRecord(withoutDate as VenmoStory, "1234567890123456789");
  assert.equal(record, null);
});

test("transactionRecord returns a null counterparty (not a throw) when actor/target is absent", () => {
  const record = transactionRecord(
    { ...RAW_PAY_STORY, payment: { ...RAW_PAY_STORY.payment, actor: null, target: null } },
    "1234567890123456789"
  );
  assert.ok(record);
  assert.equal(record?.actor, null);
  assert.equal(record?.target, null);
  assert.equal(record?.is_owner_actor, false, "no actor id means the owner cannot be the actor");
});
