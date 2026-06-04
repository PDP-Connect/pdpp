import assert from "node:assert/strict";
import test from "node:test";
import type { ExpandCapability } from "../../lib/rs-client.ts";
import {
  advisoryForReason,
  buildRelatedLinks,
  candidateParentStreamsForChild,
  childHasOneBackLinksFromManifest,
  findParentBackLink,
  parentRelationsForChild,
} from "./relationships.ts";

const USER_STATS_CAP: ExpandCapability = {
  name: "user_stats",
  stream: "user_stats",
  target_stream: "user_stats",
  cardinality: "has_many",
  child_parent_key_field: "user_id",
  foreign_key: "user_id",
  granted: true,
  usable: true,
};

function onlyLink(caps: ExpandCapability[], parentRecordKey: string) {
  const links = buildRelatedLinks(caps, { connectionId: "github", parentRecordKey });
  assert.equal(links.length, 1);
  const link = links[0];
  assert.ok(link);
  return link;
}

test("has_many usable relation links to the filtered child list, not a child detail URL", () => {
  const link = onlyLink([USER_STATS_CAP], "101");
  assert.equal(link.navigable, true);
  assert.equal(link.targetStream, "user_stats");
  assert.equal(link.childParentKeyField, "user_id");
  assert.equal(link.href, "/dashboard/records/github/user_stats?filter[user_id]=101");
  // The parent key must never appear as a child record-detail segment.
  assert.ok(!(link.href ?? "").includes("/user_stats/101"), "must not build a child detail URL from the parent key");
});

test("has_many link percent-encodes connection, stream, field, and parent key", () => {
  const cap: ExpandCapability = { ...USER_STATS_CAP, target_stream: "user stats", child_parent_key_field: "user id" };
  const links = buildRelatedLinks([cap], { connectionId: "git hub", parentRecordKey: "1/0 1" });
  const link = links[0];
  assert.ok(link);
  assert.equal(link.href, "/dashboard/records/git%20hub/user%20stats?filter[user%20id]=1%2F0%201");
});

test("unusable relation renders inert with the manifest reason as advisory", () => {
  const cap: ExpandCapability = {
    ...USER_STATS_CAP,
    granted: false,
    usable: false,
    reason: "related_stream_not_granted",
  };
  const link = onlyLink([cap], "101");
  assert.equal(link.navigable, false);
  assert.equal(link.href, undefined);
  assert.equal(link.advisory, "The related stream is not in this grant.");
});

test("each declared reason maps to calm advisory copy", () => {
  assert.ok(advisoryForReason("related_stream_not_granted").includes("not in this grant"));
  assert.ok(advisoryForReason("related_stream_unknown").includes("not in the current manifest"));
  assert.ok(advisoryForReason("related_stream_not_loaded").includes("not loaded"));
  assert.ok(advisoryForReason("something_new").includes("not available here"));
});

test("usable has_one without a resolvable child key renders inert, never a parent-key child URL", () => {
  const cap: ExpandCapability = {
    name: "profile",
    target_stream: "profile",
    stream: "profile",
    cardinality: "has_one",
    child_parent_key_field: "user_id",
    foreign_key: "user_id",
    granted: true,
    usable: true,
  };
  const link = onlyLink([cap], "101");
  assert.equal(link.cardinality, "has_one");
  assert.equal(link.navigable, false);
  assert.equal(link.href, undefined);
  // Must NOT build /profile/101 from the parent key.
  assert.ok(!String(link.href ?? "").includes("/profile/101"));
});

test("no expand capabilities yields no related links", () => {
  assert.deepEqual(buildRelatedLinks(undefined, { connectionId: "github", parentRecordKey: "101" }), []);
  assert.deepEqual(buildRelatedLinks([], { connectionId: "github", parentRecordKey: "101" }), []);
});

test("child field matching a declared relation links back to the parent record", () => {
  const link = findParentBackLink(
    "user_stats",
    { id: "101:2026-04-01", user_id: "101", observed_on: "2026-04-01" },
    [{ parentStream: "user", capability: USER_STATS_CAP }],
    { connectionId: "github" }
  );
  assert.ok(link);
  assert.equal(link.parentStream, "user");
  assert.equal(link.childParentKeyField, "user_id");
  assert.equal(link.href, "/dashboard/records/github/user/101");
});

test("child back-link is absent when no declared relation targets the child stream", () => {
  // A field that merely looks like a foreign key (repository_id) but is not
  // covered by any declared relation must NOT produce a link.
  const link = findParentBackLink(
    "issues",
    { id: "i1", repository_id: "r1" },
    [{ parentStream: "user", capability: USER_STATS_CAP }],
    { connectionId: "github" }
  );
  assert.equal(link, null);
});

test("candidateParentStreamsForChild uses the manifest only to prune parent metadata reads", () => {
  const streams = [
    {
      name: "user",
      relationships: [
        { name: "user_stats", stream: "user_stats", foreign_key: "user_id", cardinality: "has_many" as const },
      ],
      query: { expand: [{ name: "user_stats" }] },
    },
    {
      name: "repositories",
      // Declared but NOT enabled in query.expand → must be ignored.
      relationships: [
        { name: "issues", stream: "issues", foreign_key: "repository_id", cardinality: "has_many" as const },
      ],
      query: { expand: [] },
    },
    { name: "user_stats" },
  ];

  assert.deepEqual(candidateParentStreamsForChild(streams, "user_stats"), ["user"]);
  // `issues` relation is declared but disabled, so no metadata read is needed.
  assert.deepEqual(candidateParentStreamsForChild(streams, "issues"), []);
  assert.deepEqual(candidateParentStreamsForChild(undefined, "issues"), []);
});

test("parentRelationsForChild derives linkable relations from live expand_capabilities metadata", () => {
  const relations = parentRelationsForChild(
    [
      { parentStream: "user", expandCapabilities: [USER_STATS_CAP] },
      {
        parentStream: "repositories",
        expandCapabilities: [
          {
            name: "issues",
            stream: "issues",
            target_stream: "issues",
            cardinality: "has_many",
            child_parent_key_field: "repository_id",
            foreign_key: "repository_id",
            granted: false,
            usable: false,
            reason: "related_stream_not_granted",
          },
        ],
      },
    ],
    "user_stats"
  );

  assert.equal(relations.length, 1);
  assert.equal(relations[0]?.parentStream, "user");
  assert.equal(relations[0]?.capability.child_parent_key_field, "user_id");
  assert.deepEqual(parentRelationsForChild([], "user_stats"), []);
});

test("child back-link is absent when the child field value is missing or empty", () => {
  const missing = findParentBackLink(
    "user_stats",
    { id: "101:2026-04-01", observed_on: "2026-04-01" },
    [{ parentStream: "user", capability: USER_STATS_CAP }],
    { connectionId: "github" }
  );
  assert.equal(missing, null);

  const empty = findParentBackLink(
    "user_stats",
    { id: "x", user_id: "" },
    [{ parentStream: "user", capability: USER_STATS_CAP }],
    { connectionId: "github" }
  );
  assert.equal(empty, null);
});

// ── childHasOneBackLinksFromManifest ──────────────────────────────────────────

const CHASE_TRANSACTIONS_MANIFEST_STREAM = {
  name: "transactions",
  relationships: [
    { name: "account", stream: "accounts", foreign_key: "account_id", cardinality: "has_one" },
  ],
};

test("child-declared has_one links to the parent record detail page", () => {
  const links = childHasOneBackLinksFromManifest(
    CHASE_TRANSACTIONS_MANIFEST_STREAM,
    { id: "1212486749|2026042024323046109400600036029", account_id: "1212486749", amount: -1234 },
    { connectionId: "cin_029a67a16d8a252f6e3eb896" }
  );
  assert.equal(links.length, 1);
  const link = links[0];
  assert.ok(link);
  assert.equal(link.parentStream, "accounts");
  assert.equal(link.childParentKeyField, "account_id");
  assert.equal(
    link.href,
    "/dashboard/records/cin_029a67a16d8a252f6e3eb896/accounts/1212486749"
  );
});

test("child-declared has_one percent-encodes connection, stream, and key value", () => {
  const links = childHasOneBackLinksFromManifest(
    { name: "items", relationships: [{ name: "order", stream: "open orders", foreign_key: "order id", cardinality: "has_one" }] },
    { "order id": "ref/42" },
    { connectionId: "my conn" }
  );
  const link = links[0];
  assert.ok(link);
  assert.equal(link.href, "/dashboard/records/my%20conn/open%20orders/ref%2F42");
});

test("child-declared has_many relationships are ignored by childHasOneBackLinksFromManifest", () => {
  const links = childHasOneBackLinksFromManifest(
    {
      name: "transactions",
      relationships: [
        { name: "tags", stream: "tags", foreign_key: "transaction_id", cardinality: "has_many" },
      ],
    },
    { id: "tx1", transaction_id: "tx1" },
    { connectionId: "conn" }
  );
  assert.deepEqual(links, []);
});

test("unrelated id-looking fields do not link when not covered by a declared has_one", () => {
  // account_id is NOT declared in this stream's relationships — must not produce a link.
  const links = childHasOneBackLinksFromManifest(
    { name: "transactions", relationships: [] },
    { id: "tx1", account_id: "1212486749" },
    { connectionId: "conn" }
  );
  assert.deepEqual(links, []);
});

test("child-declared has_one yields no link when foreign_key field is absent from record", () => {
  const links = childHasOneBackLinksFromManifest(
    CHASE_TRANSACTIONS_MANIFEST_STREAM,
    { id: "tx1", memo: "coffee" },
    { connectionId: "cin" }
  );
  assert.deepEqual(links, []);
});

test("child-declared has_one yields no link when foreign_key value is empty", () => {
  const links = childHasOneBackLinksFromManifest(
    CHASE_TRANSACTIONS_MANIFEST_STREAM,
    { id: "tx1", account_id: "" },
    { connectionId: "cin" }
  );
  assert.deepEqual(links, []);
});

test("childHasOneBackLinksFromManifest returns empty for undefined manifest stream or record", () => {
  assert.deepEqual(childHasOneBackLinksFromManifest(undefined, { id: "x" }, { connectionId: "c" }), []);
  assert.deepEqual(childHasOneBackLinksFromManifest(CHASE_TRANSACTIONS_MANIFEST_STREAM, undefined, { connectionId: "c" }), []);
});
