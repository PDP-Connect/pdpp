// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Instagram (Meta) connector.
 *
 * IMPORTANT: meta/index.ts does not yet emit any RECORD (Polaris GraphQL
 * extraction is deferred; it emits SKIP_RESULT). So these fixtures are NOT
 * parser-derived — they are records shaped to the connector's MANIFEST stream
 * contract (manifests/meta.json). They prove the schema accepts the declared
 * contract and rejects representative drift, so the first real emit is
 * shape-checked. Whoever wires extraction MUST replace these with fixture-proven
 * records and tighten the id/media_type shapes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { postsSchema, profileSchema, validateRecord } from "./schemas.ts";

const PROFILE_RECORD = {
  id: "17841401234567890",
  username: "the owner.codes",
  full_name: "the owner N.",
  bio: "building personal-data tools 🛠️\nAustin, TX",
  follower_count: 1280,
  following_count: 311,
  post_count: 94,
  is_verified: false,
};

const POST_RECORD = {
  id: "3401234567890123456",
  caption: "Sunset over the lake 🌅 #goldenhour",
  media_type: "IMAGE",
  like_count: 212,
  comment_count: 14,
  location_name: "Lady Bird Lake",
  taken_at: "2024-05-01T23:10:00.000Z",
};

test("profile schema accepts a contract-shaped record", () => {
  assert.ok(profileSchema.safeParse(PROFILE_RECORD).success);
});

test("profile schema accepts a sparse profile (nulls for optional fields)", () => {
  const result = profileSchema.safeParse({
    ...PROFILE_RECORD,
    full_name: null,
    bio: null,
    follower_count: null,
    following_count: null,
    post_count: null,
    is_verified: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema rejects a missing username (manifest-required field)", () => {
  const { username: _omit, ...withoutUsername } = PROFILE_RECORD;
  assert.equal(profileSchema.safeParse(withoutUsername).success, false);
});

test("profile schema rejects a negative follower_count", () => {
  assert.equal(profileSchema.safeParse({ ...PROFILE_RECORD, follower_count: -1 }).success, false);
});

test("posts schema accepts a contract-shaped record", () => {
  assert.ok(postsSchema.safeParse(POST_RECORD).success);
});

test("posts schema accepts a caption-less post with null counts and location", () => {
  const result = postsSchema.safeParse({
    ...POST_RECORD,
    caption: null,
    media_type: "VIDEO",
    like_count: null,
    comment_count: null,
    location_name: null,
    taken_at: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("posts schema rejects a non-ISO taken_at (raw GraphQL epoch leaked in)", () => {
  assert.equal(postsSchema.safeParse({ ...POST_RECORD, taken_at: "1714604200" }).success, false);
});

test("posts schema rejects a negative like_count", () => {
  assert.equal(postsSchema.safeParse({ ...POST_RECORD, like_count: -5 }).success, false);
});

test("validateRecord routes both streams and passes unknown streams through", () => {
  assert.equal(validateRecord("profile", PROFILE_RECORD).ok, true);
  assert.equal(validateRecord("posts", POST_RECORD).ok, true);
  assert.equal(validateRecord("stories", { id: "x" }).ok, true);
});
