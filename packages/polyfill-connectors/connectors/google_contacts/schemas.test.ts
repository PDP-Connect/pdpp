// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { contactGroupsSchema, peopleSchema, validateRecord } from "./schemas.ts";

const PERSON_RECORD = {
  id: "people/c123",
  resource_name: "people/c123",
  deleted: false,
  display_name: "Ada Lovelace",
  names: [{ display_name: "Ada Lovelace", family_name: "Lovelace", given_name: "Ada" }],
  email_addresses: [{ type: "work", value: "ada@example.com" }],
  phone_numbers: [],
  addresses: [],
  organizations: [],
  biography: null,
  nickname: null,
  photo_url: null,
  contact_group_resource_names: ["contactGroups/myContacts"],
  updated: "2026-08-01T00:00:00Z",
  source: "google_people_api",
};

const GROUP_RECORD = {
  id: "contactGroups/myContacts",
  resource_name: "contactGroups/myContacts",
  name: "My Contacts",
  member_count: 12,
  source: "google_people_api",
};

test("people schema accepts a representative record", () => {
  const result = peopleSchema.safeParse(PERSON_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("people schema accepts a deleted tombstone with empty arrays", () => {
  const tombstone = {
    ...PERSON_RECORD,
    deleted: true,
    display_name: null,
    names: [],
    email_addresses: [],
    contact_group_resource_names: [],
  };
  assert.equal(peopleSchema.safeParse(tombstone).success, true);
});

test("people schema rejects a wrong source literal", () => {
  assert.equal(peopleSchema.safeParse({ ...PERSON_RECORD, source: "google_calendar_api" }).success, false);
});

test("contact_groups schema accepts a representative record", () => {
  assert.equal(contactGroupsSchema.safeParse(GROUP_RECORD).success, true);
});

test("contact_groups schema rejects a negative member_count", () => {
  assert.equal(contactGroupsSchema.safeParse({ ...GROUP_RECORD, member_count: -1 }).success, false);
});

test("validateRecord routes by stream and passes unknown streams through", () => {
  assert.equal(validateRecord("people", PERSON_RECORD).ok, true);
  assert.equal(validateRecord("contact_groups", GROUP_RECORD).ok, true);
  assert.equal(validateRecord("other_stream", { id: "1" }).ok, true);
});
