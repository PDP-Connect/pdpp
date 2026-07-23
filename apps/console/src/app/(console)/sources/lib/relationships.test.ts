// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { ExpandCapability } from "../../lib/rs-client.ts";
import {
  advisoryForReason,
  buildRelatedLinks,
  candidateParentStreamsForChild,
  childHasOneBackLinkForField,
  childHasOneBackLinksFromManifest,
  childHasOneLinkFields,
  findManifestForConnectorId,
  findParentBackLink,
  manifestMatchesConnectorId,
  mergeParentBackLinks,
  type ParentBackLink,
  parentBackLinkDedupKey,
  parentRelationsForChild,
  reverseChildListDedupKey,
  reverseChildListEdgesFromManifest,
  reverseChildListLinksFromManifest,
} from "./relationships.ts";

const USER_STATS_CAP: ExpandCapability = {
  cardinality: "has_many",
  child_parent_key_field: "user_id",
  foreign_key: "user_id",
  granted: true,
  name: "user_stats",
  stream: "user_stats",
  target_stream: "user_stats",
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
  assert.equal(link.href, "/sources/github/user_stats?filter[user_id]=101");
  // The parent key must never appear as a child record-detail segment.
  assert.ok(!(link.href ?? "").includes("/user_stats/101"), "must not build a child detail URL from the parent key");
});

test("has_many link percent-encodes connection, stream, field, and parent key", () => {
  const cap: ExpandCapability = { ...USER_STATS_CAP, child_parent_key_field: "user id", target_stream: "user stats" };
  const links = buildRelatedLinks([cap], { connectionId: "git hub", parentRecordKey: "1/0 1" });
  const link = links[0];
  assert.ok(link);
  assert.equal(link.href, "/sources/git%20hub/user%20stats?filter[user%20id]=1%2F0%201");
});

test("unusable relation renders inert with the manifest reason as advisory", () => {
  const cap: ExpandCapability = {
    ...USER_STATS_CAP,
    granted: false,
    reason: "related_stream_not_granted",
    usable: false,
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
    cardinality: "has_one",
    child_parent_key_field: "user_id",
    foreign_key: "user_id",
    granted: true,
    name: "profile",
    stream: "profile",
    target_stream: "profile",
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
    { id: "101:2026-04-01", observed_on: "2026-04-01", user_id: "101" },
    [{ capability: USER_STATS_CAP, parentStream: "user" }],
    { connectionId: "github" }
  );
  assert.ok(link);
  assert.equal(link.parentStream, "user");
  assert.equal(link.childParentKeyField, "user_id");
  assert.equal(link.href, "/sources/github/user/101");
});

test("child back-link can be resolved for the requested relation field", () => {
  const ownerStatsCap: ExpandCapability = {
    ...USER_STATS_CAP,
    child_parent_key_field: "owner_id",
    foreign_key: "owner_id",
  };
  const link = findParentBackLink(
    "user_stats",
    { id: "101:2026-04-01", owner_id: "owner-1", user_id: "user-1" },
    [
      { capability: USER_STATS_CAP, parentStream: "user" },
      { capability: ownerStatsCap, parentStream: "owners" },
    ],
    { childParentKeyField: "owner_id", connectionId: "github" }
  );
  assert.ok(link);
  assert.equal(link.parentStream, "owners");
  assert.equal(link.childParentKeyField, "owner_id");
  assert.equal(link.href, "/sources/github/owners/owner-1");
});

test("child back-link is absent when no declared relation targets the child stream", () => {
  // A field that merely looks like a foreign key (repository_id) but is not
  // covered by any declared relation must NOT produce a link.
  const link = findParentBackLink(
    "issues",
    { id: "i1", repository_id: "r1" },
    [{ capability: USER_STATS_CAP, parentStream: "user" }],
    { connectionId: "github" }
  );
  assert.equal(link, null);
});

test("candidateParentStreamsForChild uses the manifest only to prune parent metadata reads", () => {
  const streams = [
    {
      name: "user",
      query: { expand: [{ name: "user_stats" }] },
      relationships: [
        { cardinality: "has_many" as const, foreign_key: "user_id", name: "user_stats", stream: "user_stats" },
      ],
    },
    {
      name: "repositories",
      query: { expand: [] },
      // Declared but NOT enabled in query.expand → must be ignored.
      relationships: [
        { cardinality: "has_many" as const, foreign_key: "repository_id", name: "issues", stream: "issues" },
      ],
    },
    { name: "user_stats" },
  ];

  assert.deepEqual(candidateParentStreamsForChild(streams, "user_stats"), ["user"]);
  // `issues` relation is declared but disabled, so no metadata read is needed.
  assert.deepEqual(candidateParentStreamsForChild(streams, "issues"), []);
  assert.deepEqual(candidateParentStreamsForChild(undefined, "issues"), []);
});

test("manifest lookup tolerates URL-form connector_id and short connector_key", () => {
  const manifests = [
    {
      connector_id: "https://registry.pdpp.org/connectors/chase",
      connector_key: "chase",
      streams: [{ name: "transactions" }],
    },
    {
      connector_id: "https://registry.pdpp.org/connectors/github",
      connector_key: "github",
      streams: [{ name: "user" }],
    },
  ];
  const chaseManifest = manifests[0];
  assert.ok(chaseManifest);

  assert.equal(manifestMatchesConnectorId(chaseManifest, "chase"), true);
  assert.equal(manifestMatchesConnectorId(chaseManifest, "https://registry.pdpp.org/connectors/chase"), true);
  assert.equal(manifestMatchesConnectorId(chaseManifest, "github"), false);
  assert.equal(manifestMatchesConnectorId(chaseManifest, ""), false);
  assert.equal(findManifestForConnectorId(manifests, "chase")?.connector_key, "chase");
  assert.equal(
    findManifestForConnectorId(manifests, "https://registry.pdpp.org/connectors/github")?.connector_key,
    "github"
  );
  assert.equal(findManifestForConnectorId(manifests, "slack"), undefined);
});

test("short connection connector key resolves child-declared relationship manifest stream", () => {
  const manifests = [
    {
      connector_id: "https://registry.pdpp.org/connectors/chase",
      connector_key: "chase",
      streams: [CHASE_TRANSACTIONS_MANIFEST_STREAM],
    },
  ];

  const connectorManifest = findManifestForConnectorId(manifests, "chase");
  const stream = connectorManifest?.streams.find((candidate) => candidate.name === "transactions");
  const links = childHasOneBackLinksFromManifest(
    stream,
    { account_id: "1212486749", id: "1212486749|2026042024323046109400600036029" },
    { connectionId: "cin_029a67a16d8a252f6e3eb896" }
  );

  assert.equal(links[0]?.href, "/sources/cin_029a67a16d8a252f6e3eb896/accounts/1212486749");
});

test("parentRelationsForChild derives linkable relations from live expand_capabilities metadata", () => {
  const relations = parentRelationsForChild(
    [
      { expandCapabilities: [USER_STATS_CAP], parentStream: "user" },
      {
        expandCapabilities: [
          {
            cardinality: "has_many",
            child_parent_key_field: "repository_id",
            foreign_key: "repository_id",
            granted: false,
            name: "issues",
            reason: "related_stream_not_granted",
            stream: "issues",
            target_stream: "issues",
            usable: false,
          },
        ],
        parentStream: "repositories",
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
    [{ capability: USER_STATS_CAP, parentStream: "user" }],
    { connectionId: "github" }
  );
  assert.equal(missing, null);

  const empty = findParentBackLink(
    "user_stats",
    { id: "x", user_id: "" },
    [{ capability: USER_STATS_CAP, parentStream: "user" }],
    { connectionId: "github" }
  );
  assert.equal(empty, null);
});

// ── childHasOneBackLinksFromManifest ──────────────────────────────────────────

const CHASE_TRANSACTIONS_MANIFEST_STREAM = {
  name: "transactions",
  relationships: [{ cardinality: "has_one", foreign_key: "account_id", name: "account", stream: "accounts" }],
};

test("child-declared has_one links to the parent record detail page", () => {
  const links = childHasOneBackLinksFromManifest(
    CHASE_TRANSACTIONS_MANIFEST_STREAM,
    { account_id: "1212486749", amount: -1234, id: "1212486749|2026042024323046109400600036029" },
    { connectionId: "cin_029a67a16d8a252f6e3eb896" }
  );
  assert.equal(links.length, 1);
  const link = links[0];
  assert.ok(link);
  assert.equal(link.parentStream, "accounts");
  assert.equal(link.childParentKeyField, "account_id");
  assert.equal(link.href, "/sources/cin_029a67a16d8a252f6e3eb896/accounts/1212486749");
});

test("child-declared has_one percent-encodes connection, stream, and key value", () => {
  const links = childHasOneBackLinksFromManifest(
    {
      name: "items",
      relationships: [{ cardinality: "has_one", foreign_key: "order id", name: "order", stream: "open orders" }],
    },
    { "order id": "ref/42" },
    { connectionId: "my conn" }
  );
  const link = links[0];
  assert.ok(link);
  assert.equal(link.href, "/sources/my%20conn/open%20orders/ref%2F42");
});

test("child-declared has_many relationships are ignored by childHasOneBackLinksFromManifest", () => {
  const links = childHasOneBackLinksFromManifest(
    {
      name: "transactions",
      relationships: [{ cardinality: "has_many", foreign_key: "transaction_id", name: "tags", stream: "tags" }],
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
    { account_id: "1212486749", id: "tx1" },
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
    { account_id: "", id: "tx1" },
    { connectionId: "cin" }
  );
  assert.deepEqual(links, []);
});

test("childHasOneBackLinksFromManifest returns empty for undefined manifest stream or record", () => {
  assert.deepEqual(childHasOneBackLinksFromManifest(undefined, { id: "x" }, { connectionId: "c" }), []);
  assert.deepEqual(
    childHasOneBackLinksFromManifest(CHASE_TRANSACTIONS_MANIFEST_STREAM, undefined, { connectionId: "c" }),
    []
  );
});

// ── childHasOneLinkFields / childHasOneBackLinkForField (list-page per-cell) ───
//
// The record list page resolves links one cell (column) at a time. These two
// helpers let it render a child-declared `has_one` foreign-key cell as a link to
// the parent record — the same affordance the detail page shows — without
// inspecting undeclared payload fields.

test("childHasOneLinkFields returns only declared has_one foreign-key field names", () => {
  const fields = childHasOneLinkFields(YNAB_TRANSACTIONS_TWO_ACCOUNT_EDGES);
  assert.deepEqual([...fields].sort(), ["account_id", "transfer_account_id"]);
});

test("childHasOneLinkFields ignores has_many and incomplete relations, and tolerates absent input", () => {
  const fields = childHasOneLinkFields({
    name: "transactions",
    relationships: [
      { cardinality: "has_many", foreign_key: "transaction_id", name: "tags", stream: "tags" },
      { cardinality: "has_one", name: "account", stream: "accounts" }, // missing foreign_key
      { cardinality: "has_one", foreign_key: "owner_id", name: "owner" }, // missing stream
      { cardinality: "has_one", foreign_key: "category_id", name: "category", stream: "categories" },
    ],
  });
  assert.deepEqual([...fields], ["category_id"]);
  assert.deepEqual([...childHasOneLinkFields(undefined)], []);
  assert.deepEqual([...childHasOneLinkFields({ name: "x" })], []);
});

test("childHasOneBackLinkForField links a declared has_one cell to the parent record", () => {
  const link = childHasOneBackLinkForField(
    CHASE_TRANSACTIONS_MANIFEST_STREAM,
    { account_id: "1212486749", amount: -1234, id: "tx1" },
    "account_id",
    { connectionId: "cin_chase" }
  );
  assert.ok(link);
  assert.equal(link.parentStream, "accounts");
  assert.equal(link.childParentKeyField, "account_id");
  assert.equal(link.href, "/sources/cin_chase/accounts/1212486749");
});

test("childHasOneBackLinkForField resolves each field of a two-edges-to-same-parent stream independently", () => {
  // YNAB transactions: account_id and transfer_account_id are different columns
  // and resolve to DIFFERENT account records — the list page links each cell.
  const record = { account_id: "acc-A", id: "t1", transfer_account_id: "acc-B" };
  const a = childHasOneBackLinkForField(YNAB_TRANSACTIONS_TWO_ACCOUNT_EDGES, record, "account_id", {
    connectionId: "cin_ynab",
  });
  const b = childHasOneBackLinkForField(YNAB_TRANSACTIONS_TWO_ACCOUNT_EDGES, record, "transfer_account_id", {
    connectionId: "cin_ynab",
  });
  assert.equal(a?.href, "/sources/cin_ynab/accounts/acc-A");
  assert.equal(b?.href, "/sources/cin_ynab/accounts/acc-B");
  assert.notEqual(a?.href, b?.href);
});

test("childHasOneBackLinkForField percent-encodes connection, parent stream, and value", () => {
  const link = childHasOneBackLinkForField(
    {
      name: "items",
      relationships: [{ cardinality: "has_one", foreign_key: "order id", name: "order", stream: "open orders" }],
    },
    { "order id": "ref/42" },
    "order id",
    { connectionId: "my conn" }
  );
  assert.equal(link?.href, "/sources/my%20conn/open%20orders/ref%2F42");
});

test("childHasOneBackLinkForField returns null for an undeclared field or empty/absent value", () => {
  // Undeclared field — never a link, even though it looks like a foreign key.
  assert.equal(
    childHasOneBackLinkForField(CHASE_TRANSACTIONS_MANIFEST_STREAM, { id: "tx1", merchant_id: "m1" }, "merchant_id", {
      connectionId: "cin",
    }),
    null
  );
  // Declared field but empty value.
  assert.equal(
    childHasOneBackLinkForField(CHASE_TRANSACTIONS_MANIFEST_STREAM, { account_id: "", id: "tx1" }, "account_id", {
      connectionId: "cin",
    }),
    null
  );
  // Declared field but the record does not carry it.
  assert.equal(
    childHasOneBackLinkForField(CHASE_TRANSACTIONS_MANIFEST_STREAM, { id: "tx1", memo: "coffee" }, "account_id", {
      connectionId: "cin",
    }),
    null
  );
});

// ── reverseChildListLinksFromManifest ─────────────────────────────────────────

// Chase-shaped manifest: `accounts` parent + `transactions` child declaring a
// `has_one` back to `accounts` via `account_id`. This is the proving scenario.
const CHASE_STREAMS = [
  { name: "accounts" },
  {
    name: "transactions",
    relationships: [{ cardinality: "has_one", foreign_key: "account_id", name: "account", stream: "accounts" }],
  },
];

test("Chase accounts parent yields a transactions filtered-list link, never a detail URL", () => {
  const links = reverseChildListLinksFromManifest(CHASE_STREAMS, {
    connectionId: "cin_029a67a16d8a252f6e3eb896",
    parentRecordKey: "1212486749",
    parentStream: "accounts",
  });
  assert.equal(links.length, 1);
  const link = links[0];
  assert.ok(link);
  assert.equal(link.childStream, "transactions");
  assert.equal(link.foreignKey, "account_id");
  // Filtered child LIST, keyed by the parent key as the filter value.
  assert.equal(link.href, "/sources/cin_029a67a16d8a252f6e3eb896/transactions?filter[account_id]=1212486749");
  // Must NOT build a `.../transactions/<accountKey>` child record-detail URL.
  assert.ok(!link.href.includes("/transactions/1212486749"), "must not build a child detail URL from the parent key");
});

test("reverse link is a filtered list URL with a filter[…] query, never a detail segment", () => {
  const [link] = reverseChildListLinksFromManifest(CHASE_STREAMS, {
    connectionId: "chase",
    parentRecordKey: "acc1",
    parentStream: "accounts",
  });
  assert.ok(link);
  // The path part ends at the child stream; the parent key is only in the query.
  const [path, query] = link.href.split("?");
  assert.equal(path, "/sources/chase/transactions");
  assert.equal(query, "filter[account_id]=acc1");
});

test("a child-declared has_many produces no reverse link", () => {
  const streams = [
    { name: "transactions" },
    {
      name: "tags",
      // has_many back to the parent — must NOT yield a reverse link by this rule.
      relationships: [
        { cardinality: "has_many", foreign_key: "transaction_id", name: "transaction", stream: "transactions" },
      ],
    },
  ];
  assert.deepEqual(
    reverseChildListLinksFromManifest(streams, {
      connectionId: "conn",
      parentRecordKey: "tx1",
      parentStream: "transactions",
    }),
    []
  );
});

test("a parent stream not targeted by any child has_one produces no reverse link", () => {
  // `transactions` declares has_one to `accounts`, NOT to `merchants`. Standing
  // on a `merchants` parent yields nothing, even though a foreign-key-looking
  // field exists elsewhere.
  const links = reverseChildListLinksFromManifest(CHASE_STREAMS, {
    connectionId: "chase",
    parentRecordKey: "m1",
    parentStream: "merchants",
  });
  assert.deepEqual(links, []);
});

test("a child has_one without a foreign_key produces no reverse link", () => {
  const streams = [
    { name: "accounts" },
    { name: "transactions", relationships: [{ cardinality: "has_one", name: "account", stream: "accounts" }] },
  ];
  assert.deepEqual(
    reverseChildListLinksFromManifest(streams, {
      connectionId: "chase",
      parentRecordKey: "a1",
      parentStream: "accounts",
    }),
    []
  );
});

test("reverse link percent-encodes connection, child stream, filter field, and parent key", () => {
  const streams = [
    { name: "open orders" },
    {
      name: "line items",
      relationships: [{ cardinality: "has_one", foreign_key: "order id", name: "order", stream: "open orders" }],
    },
  ];
  const [link] = reverseChildListLinksFromManifest(streams, {
    connectionId: "my conn",
    parentRecordKey: "ref/42",
    parentStream: "open orders",
  });
  assert.ok(link);
  assert.equal(link.href, "/sources/my%20conn/line%20items?filter[order%20id]=ref%2F42");
});

test("reverse links resolve via findManifestForConnectorId for URL-form and short connector keys", () => {
  const manifests = [
    {
      connector_id: "https://registry.pdpp.org/connectors/chase",
      connector_key: "chase",
      streams: CHASE_STREAMS,
    },
  ];

  for (const id of ["chase", "https://registry.pdpp.org/connectors/chase"]) {
    const manifest = findManifestForConnectorId(manifests, id);
    assert.ok(manifest, `manifest should resolve for ${id}`);
    const links = reverseChildListLinksFromManifest(manifest.streams, {
      connectionId: "cin_live",
      parentRecordKey: "a1",
      parentStream: "accounts",
    });
    assert.equal(links.length, 1);
    assert.equal(links[0]?.href, "/sources/cin_live/transactions?filter[account_id]=a1");
  }
});

test("reverse link deduplicates against a forward has_many target on the same child stream and field", () => {
  // A parent that both advertises a has_many expand_capability AND has a child
  // declaring has_one back to it must render a SINGLE link, not two.
  const forwardLinks = buildRelatedLinks(
    [
      {
        cardinality: "has_many",
        child_parent_key_field: "account_id",
        foreign_key: "account_id",
        granted: true,
        name: "transactions",
        stream: "transactions",
        target_stream: "transactions",
        usable: true,
      },
    ],
    { connectionId: "chase", parentRecordKey: "a1" }
  );
  assert.equal(forwardLinks.length, 1);
  const forwardKeys = new Set(
    forwardLinks
      .filter((l) => l.navigable && l.cardinality === "has_many" && l.childParentKeyField)
      .map((l) => reverseChildListDedupKey(l.targetStream, l.childParentKeyField as string))
  );

  const reverse = reverseChildListLinksFromManifest(
    CHASE_STREAMS,
    { connectionId: "chase", parentRecordKey: "a1", parentStream: "accounts" },
    forwardKeys
  );
  // Forward already covers (transactions, account_id) → reverse suppresses it.
  assert.deepEqual(reverse, []);
});

test("reverse link is kept when a forward has_many targets a different child stream or field", () => {
  const forwardKeys = new Set([reverseChildListDedupKey("other_stream", "account_id")]);
  const reverse = reverseChildListLinksFromManifest(
    CHASE_STREAMS,
    { connectionId: "chase", parentRecordKey: "a1", parentStream: "accounts" },
    forwardKeys
  );
  assert.equal(reverse.length, 1);
  assert.equal(reverse[0]?.childStream, "transactions");
});

test("reverse link self-deduplicates a child stream declaring the same has_one twice", () => {
  const streams = [
    { name: "accounts" },
    {
      name: "transactions",
      relationships: [
        { cardinality: "has_one", foreign_key: "account_id", name: "account", stream: "accounts" },
        { cardinality: "has_one", foreign_key: "account_id", name: "owning_account", stream: "accounts" },
      ],
    },
  ];
  const links = reverseChildListLinksFromManifest(streams, {
    connectionId: "chase",
    parentRecordKey: "a1",
    parentStream: "accounts",
  });
  assert.equal(links.length, 1);
});

test("reverseChildListLinksFromManifest returns empty for missing streams or args", () => {
  assert.deepEqual(
    reverseChildListLinksFromManifest(undefined, {
      connectionId: "c",
      parentRecordKey: "a1",
      parentStream: "accounts",
    }),
    []
  );
  assert.deepEqual(
    reverseChildListLinksFromManifest(CHASE_STREAMS, { connectionId: "c", parentRecordKey: "a1", parentStream: "" }),
    []
  );
  assert.deepEqual(
    reverseChildListLinksFromManifest(CHASE_STREAMS, {
      connectionId: "c",
      parentRecordKey: "",
      parentStream: "accounts",
    }),
    []
  );
});

test("reverseChildListDedupKey is stable and distinguishes stream from field", () => {
  assert.equal(
    reverseChildListDedupKey("transactions", "account_id"),
    reverseChildListDedupKey("transactions", "account_id")
  );
  assert.notEqual(
    reverseChildListDedupKey("transactions", "account_id"),
    reverseChildListDedupKey("transactions", "merchant_id")
  );
  assert.notEqual(
    reverseChildListDedupKey("transactions", "account_id"),
    reverseChildListDedupKey("transfers", "account_id")
  );
});

// ── reverseChildListEdgesFromManifest (list-page per-row prerequisite) ─────────

test("reverseChildListEdgesFromManifest returns the child-stream edge set for a parent", () => {
  // The page-level "does this stream have reverse child edges?" set, computed
  // once per list page from the already-loaded connector manifest.
  const edges = reverseChildListEdgesFromManifest(CHASE_STREAMS, "accounts");
  assert.deepEqual(edges, [{ childStream: "transactions", foreignKey: "account_id" }]);
});

test("reverseChildListEdgesFromManifest is empty for a childless parent stream", () => {
  // `transactions` is the child here; nothing declares a has_one back to it, so
  // its list page does no per-row reverse work.
  assert.deepEqual(reverseChildListEdgesFromManifest(CHASE_STREAMS, "transactions"), []);
});

test("reverseChildListEdgesFromManifest is empty for missing manifest or empty parent stream", () => {
  assert.deepEqual(reverseChildListEdgesFromManifest(undefined, "accounts"), []);
  assert.deepEqual(reverseChildListEdgesFromManifest(CHASE_STREAMS, ""), []);
});

test("reverseChildListEdgesFromManifest ignores a child-declared has_many", () => {
  const streams = [
    { name: "transactions" },
    {
      name: "tags",
      relationships: [
        { cardinality: "has_many", foreign_key: "transaction_id", name: "transaction", stream: "transactions" },
      ],
    },
  ];
  assert.deepEqual(reverseChildListEdgesFromManifest(streams, "transactions"), []);
});

test("reverseChildListEdgesFromManifest self-dedups a child declaring the same has_one twice", () => {
  const streams = [
    { name: "accounts" },
    {
      name: "transactions",
      relationships: [
        { cardinality: "has_one", foreign_key: "account_id", name: "account", stream: "accounts" },
        { cardinality: "has_one", foreign_key: "account_id", name: "owning_account", stream: "accounts" },
      ],
    },
  ];
  assert.deepEqual(reverseChildListEdgesFromManifest(streams, "accounts"), [
    { childStream: "transactions", foreignKey: "account_id" },
  ]);
});

test("reverseChildListEdgesFromManifest lists multiple distinct child streams and the per-edge has_one fields", () => {
  // A Chase-like `accounts` parent with several belongs-to children, mirroring
  // the real manifest (balances/current_activity/statements/transactions all
  // declare has_one → accounts).
  const streams = [
    { name: "accounts" },
    {
      name: "balances",
      relationships: [{ cardinality: "has_one", foreign_key: "account_id", name: "account", stream: "accounts" }],
    },
    {
      name: "statements",
      relationships: [{ cardinality: "has_one", foreign_key: "account_id", name: "account", stream: "accounts" }],
    },
    {
      name: "transactions",
      relationships: [{ cardinality: "has_one", foreign_key: "account_id", name: "account", stream: "accounts" }],
    },
    // A non-matching child (points at a different parent) must not appear.
    {
      name: "merchants",
      relationships: [{ cardinality: "has_one", foreign_key: "category_id", name: "category", stream: "categories" }],
    },
  ];
  assert.deepEqual(reverseChildListEdgesFromManifest(streams, "accounts"), [
    { childStream: "balances", foreignKey: "account_id" },
    { childStream: "statements", foreignKey: "account_id" },
    { childStream: "transactions", foreignKey: "account_id" },
  ]);
});

// ── list-page per-row reverse links (the wiring this change adds) ──────────────

test("a Chase accounts list renders a distinct filtered-transactions link per row", () => {
  // The list page computes the edge set once, then builds each row's links by
  // substituting that row's own record key as the filter value. This models the
  // page's per-row call to reverseChildListLinksFromManifest(..., parentRecordKey:
  // row.id).
  assert.ok(reverseChildListEdgesFromManifest(CHASE_STREAMS, "accounts").length > 0, "edge set must be non-empty");
  const rows = [{ id: "1212486749" }, { id: "9988776655" }];
  const perRow = rows.map((row) =>
    reverseChildListLinksFromManifest(CHASE_STREAMS, {
      connectionId: "cin_live",
      parentRecordKey: row.id,
      parentStream: "accounts",
    })
  );
  assert.equal(perRow[0]?.length, 1);
  assert.equal(perRow[1]?.length, 1);
  // Each row's link filters by THAT row's key — distinct filter values, never a
  // child record-detail URL built from the parent key.
  assert.equal(perRow[0]?.[0]?.href, "/sources/cin_live/transactions?filter[account_id]=1212486749");
  assert.equal(perRow[1]?.[0]?.href, "/sources/cin_live/transactions?filter[account_id]=9988776655");
  assert.notEqual(perRow[0]?.[0]?.href, perRow[1]?.[0]?.href);
  for (const links of perRow) {
    for (const link of links) {
      assert.ok(!link.href.includes("/transactions/12"), "must not build a child detail URL from the parent key");
    }
  }
});

test("a list page for a childless stream yields no per-row reverse links", () => {
  // Standing on `transactions` (a leaf child), the page-level gate is false, so
  // the page renders no per-row reverse links and does no per-row work.
  assert.equal(reverseChildListEdgesFromManifest(CHASE_STREAMS, "transactions").length, 0);
  const links = reverseChildListLinksFromManifest(CHASE_STREAMS, {
    connectionId: "cin_live",
    parentRecordKey: "t1",
    parentStream: "transactions",
  });
  assert.deepEqual(links, []);
});

// ── mergeParentBackLinks ──────────────────────────────────────────────────────

// A YNAB transaction declares TWO has_one edges to `accounts` via distinct
// fields — `account_id` (the posting account) and `transfer_account_id` (the
// other side of a transfer). They carry different values, so they resolve to
// DIFFERENT account records and must both render. This is the regression the
// merge guards: a parentStream-only dedup would silently drop one.
const YNAB_TRANSACTIONS_TWO_ACCOUNT_EDGES = {
  name: "transactions",
  relationships: [
    { cardinality: "has_one", foreign_key: "account_id", name: "account", stream: "accounts" },
    { cardinality: "has_one", foreign_key: "transfer_account_id", name: "transfer_account", stream: "accounts" },
  ],
};

test("two child-declared has_one edges to the same parent stream via different fields both render", () => {
  const childLinks = childHasOneBackLinksFromManifest(
    YNAB_TRANSACTIONS_TWO_ACCOUNT_EDGES,
    { account_id: "acc-A", id: "t1", transfer_account_id: "acc-B" },
    { connectionId: "cin_ynab" }
  );
  const merged = mergeParentBackLinks(null, childLinks);
  assert.equal(merged.length, 2, "both account edges must survive the merge");
  const byField = new Map(merged.map((l) => [l.childParentKeyField, l]));
  assert.equal(byField.get("account_id")?.href, "/sources/cin_ynab/accounts/acc-A");
  assert.equal(byField.get("transfer_account_id")?.href, "/sources/cin_ynab/accounts/acc-B");
  // The two links point at DIFFERENT account records, not the same one.
  assert.notEqual(byField.get("account_id")?.href, byField.get("transfer_account_id")?.href);
});

test("mergeParentBackLinks collapses the SAME edge discovered via both sources", () => {
  // metadata source and child-declared source describe the same (accounts,
  // account_id) edge → one link, metadata-derived preferred.
  const metadata: ParentBackLink = {
    childParentKeyField: "account_id",
    href: "/sources/cin/accounts/acc-A",
    parentStream: "accounts",
  };
  const childDeclared = childHasOneBackLinksFromManifest(
    CHASE_TRANSACTIONS_MANIFEST_STREAM,
    { account_id: "acc-A", id: "t1" },
    { connectionId: "cin" }
  );
  const merged = mergeParentBackLinks(metadata, childDeclared);
  assert.equal(merged.length, 1, "same (parentStream, field) from both sources collapses to one");
  assert.equal(merged[0], metadata, "the metadata-derived link is preferred");
});

test("mergeParentBackLinks keeps distinct parent streams and is order-stable", () => {
  const childLinks: ParentBackLink[] = [
    { childParentKeyField: "account_id", href: "/a", parentStream: "accounts" },
    { childParentKeyField: "payee_id", href: "/p", parentStream: "payees" },
    { childParentKeyField: "category_id", href: "/c", parentStream: "categories" },
  ];
  const merged = mergeParentBackLinks(null, childLinks);
  assert.deepEqual(
    merged.map((l) => l.parentStream),
    ["accounts", "payees", "categories"]
  );
});

test("mergeParentBackLinks returns empty when there are no links", () => {
  assert.deepEqual(mergeParentBackLinks(null, []), []);
});

test("parentBackLinkDedupKey is stable and distinguishes stream from field", () => {
  assert.equal(parentBackLinkDedupKey("accounts", "account_id"), parentBackLinkDedupKey("accounts", "account_id"));
  // Same parent stream, different field → distinct keys (the YNAB case).
  assert.notEqual(
    parentBackLinkDedupKey("accounts", "account_id"),
    parentBackLinkDedupKey("accounts", "transfer_account_id")
  );
  // Different parent stream, same field → distinct keys.
  assert.notEqual(parentBackLinkDedupKey("accounts", "account_id"), parentBackLinkDedupKey("payees", "account_id"));
});
