// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Completeness-anchor tests for the `contact_groups` stream.
 *
 * `contact_groups` is manifest-REQUIRED and had emitted zero records for
 * this owner, ever — including zero tombstones. The connector read only the
 * vCard-standard `CATEGORIES` property, but iCloud stores each group as its
 * own vCard resource marked `X-ADDRESSBOOKSERVER-KIND:group`. So for an
 * iCloud account the stream could not emit a record no matter what the
 * account contained, and the resulting zero was indistinguishable from a
 * genuinely empty address book.
 *
 * The vCard bodies below use Apple's real wire shape.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type GroupAnchor,
  groupAnchorVerdict,
  groupMemberUids,
  isGroupVCard,
  partitionVCards,
} from "./group-vcards.ts";
import { parseVCards } from "./vcard.ts";

/** Apple's real group-vCard wire shape, as iCloud serves it. */
const APPLE_GROUP_VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Family;;;;",
  "FN:Family",
  "UID:11111111-2222-3333-4444-555555555555",
  "X-ADDRESSBOOKSERVER-KIND:group",
  "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:AAAAAAAA-0000-0000-0000-000000000001",
  "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:BBBBBBBB-0000-0000-0000-000000000002",
  "END:VCARD",
].join("\r\n");

const PERSON_VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Tim Nunamaker",
  "UID:AAAAAAAA-0000-0000-0000-000000000001",
  "END:VCARD",
].join("\r\n");

const PERSON_WITH_CATEGORIES = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Someone Else",
  "UID:BBBBBBBB-0000-0000-0000-000000000002",
  "CATEGORIES:Work,Friends",
  "END:VCARD",
].join("\r\n");

function card(text: string) {
  const [parsed] = parseVCards(text);
  assert.ok(parsed, "fixture failed to parse");
  return parsed;
}

// ─── isGroupVCard: see the groups iCloud actually ships ──────────────────

test("isGroupVCard recognises Apple's real group vCard", () => {
  // Before this, the connector was blind to exactly this resource.
  assert.equal(isGroupVCard(card(APPLE_GROUP_VCARD)), true);
});

test("isGroupVCard recognises the RFC 6350 standard KIND:group", () => {
  const standard = ["BEGIN:VCARD", "VERSION:4.0", "FN:Team", "KIND:group", "END:VCARD"].join("\r\n");
  assert.equal(isGroupVCard(card(standard)), true);
});

test("isGroupVCard is case-insensitive on the value", () => {
  const upper = ["BEGIN:VCARD", "VERSION:3.0", "FN:Team", "X-ADDRESSBOOKSERVER-KIND:GROUP", "END:VCARD"].join("\r\n");
  assert.equal(isGroupVCard(card(upper)), true);
});

test("isGroupVCard treats an ordinary person as a contact", () => {
  assert.equal(isGroupVCard(card(PERSON_VCARD)), false);
});

test("isGroupVCard fails safe toward contact on an unknown KIND", () => {
  // A resource is a group only when the server explicitly says so, so this
  // predicate can never silently drop a real person from `contacts`.
  const org = ["BEGIN:VCARD", "VERSION:4.0", "FN:ACME", "KIND:org", "END:VCARD"].join("\r\n");
  assert.equal(isGroupVCard(card(org)), false);
});

// ─── groupMemberUids ─────────────────────────────────────────────────────

test("groupMemberUids strips the urn:uuid: prefix Apple ships", () => {
  assert.deepEqual(groupMemberUids(card(APPLE_GROUP_VCARD)), [
    "AAAAAAAA-0000-0000-0000-000000000001",
    "BBBBBBBB-0000-0000-0000-000000000002",
  ]);
});

test("groupMemberUids returns empty for a group with no members", () => {
  const empty = ["BEGIN:VCARD", "VERSION:3.0", "FN:Empty", "X-ADDRESSBOOKSERVER-KIND:group", "END:VCARD"].join("\r\n");
  assert.deepEqual(groupMemberUids(card(empty)), []);
});

test("groupMemberUids de-duplicates while preserving order", () => {
  const dupes = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Dupes",
    "X-ADDRESSBOOKSERVER-KIND:group",
    "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:B",
    "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:A",
    "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:B",
    "END:VCARD",
  ].join("\r\n");
  assert.deepEqual(groupMemberUids(card(dupes)), ["B", "A"]);
});

// ─── partitionVCards: the phantom-contact fix ────────────────────────────

test("partitionVCards keeps a group vCard out of the contact set", () => {
  // The phantom-contact defect: a group emitted as a contact whose
  // display_name is the group's name, counted as a covered contact.
  const resources = [
    { card: card(PERSON_VCARD) },
    { card: card(APPLE_GROUP_VCARD) },
    { card: card(PERSON_WITH_CATEGORIES) },
  ];
  const { contacts, groups } = partitionVCards(resources);
  assert.equal(contacts.length, 2);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.card.fn, "Family");
  assert.equal(
    contacts.some((c) => c.card.fn === "Family"),
    false,
    "group leaked into the contact set"
  );
});

test("partitionVCards handles a collection with no groups", () => {
  const { contacts, groups } = partitionVCards([{ card: card(PERSON_VCARD) }]);
  assert.equal(contacts.length, 1);
  assert.equal(groups.length, 0);
});

// ─── groupAnchorVerdict: the anchor ──────────────────────────────────────

function anchor(overrides: Partial<GroupAnchor>): GroupAnchor {
  return {
    serverGroupVCards: 0,
    derivedCategoryGroups: 0,
    emitted: 0,
    boundaryEstablished: true,
    ...overrides,
  };
}

test("groupAnchorVerdict refuses to claim anything without a boundary", () => {
  // An incomplete enumeration cannot prove or disprove completeness.
  const verdict = groupAnchorVerdict(anchor({ boundaryEstablished: false, serverGroupVCards: 3 }));
  assert.equal(verdict.status, "unproven");
});

test("groupAnchorVerdict turns the live zero into a CHECKED zero", () => {
  // This is the outcome that resolves the original question: the server
  // enumerated the whole collection and it genuinely holds no groups.
  assert.equal(groupAnchorVerdict(anchor({})).status, "empty_confirmed");
});

test("groupAnchorVerdict reports SHORT when the server holds groups we did not emit", () => {
  // The blindness case: iCloud has 3 group vCards, the connector emitted none.
  const verdict = groupAnchorVerdict(anchor({ serverGroupVCards: 3, emitted: 0 }));
  assert.equal(verdict.status, "short");
  assert.equal(verdict.status === "short" && verdict.missing, 3);
  assert.equal(verdict.status === "short" && verdict.considered, 3);
});

test("groupAnchorVerdict reports COMPLETE when every server group was emitted", () => {
  const verdict = groupAnchorVerdict(anchor({ serverGroupVCards: 2, emitted: 2 }));
  assert.equal(verdict.status, "complete");
  assert.equal(verdict.status === "complete" && verdict.covered, 2);
});

test("groupAnchorVerdict does NOT flag CATEGORIES groups as an overage", () => {
  // CATEGORIES groups have no server-side resource, so emitting more than
  // the measured denominator is correct behaviour, not a defect. A two-way
  // equality here would flag correct behaviour as failure.
  const verdict = groupAnchorVerdict(anchor({ serverGroupVCards: 1, derivedCategoryGroups: 2, emitted: 3 }));
  assert.equal(verdict.status, "complete");
});

test("groupAnchorVerdict keeps a partial shortfall visible", () => {
  // 4 server groups, only 1 emitted: still short by 3 even though something
  // was emitted.
  const verdict = groupAnchorVerdict(anchor({ serverGroupVCards: 4, emitted: 1 }));
  assert.equal(verdict.status, "short");
  assert.equal(verdict.status === "short" && verdict.missing, 3);
});

test("groupAnchorVerdict does not confirm empty when CATEGORIES groups exist", () => {
  // A CATEGORIES-only account is not an empty one; claiming
  // `empty_confirmed` there would be a false clean bill.
  const verdict = groupAnchorVerdict(anchor({ derivedCategoryGroups: 2, emitted: 2 }));
  assert.notEqual(verdict.status, "empty_confirmed");
});
