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
  reverseChildListLinksFromManifest,
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
      { parentStream: "user", capability: USER_STATS_CAP },
      { parentStream: "owners", capability: ownerStatsCap },
    ],
    { childParentKeyField: "owner_id", connectionId: "github" }
  );
  assert.ok(link);
  assert.equal(link.parentStream, "owners");
  assert.equal(link.childParentKeyField, "owner_id");
  assert.equal(link.href, "/dashboard/records/github/owners/owner-1");
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

  assert.equal(manifestMatchesConnectorId(manifests[0]!, "chase"), true);
  assert.equal(manifestMatchesConnectorId(manifests[0]!, "https://registry.pdpp.org/connectors/chase"), true);
  assert.equal(manifestMatchesConnectorId(manifests[0]!, "github"), false);
  assert.equal(manifestMatchesConnectorId(manifests[0]!, ""), false);
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
    { id: "1212486749|2026042024323046109400600036029", account_id: "1212486749" },
    { connectionId: "cin_029a67a16d8a252f6e3eb896" }
  );

  assert.equal(links[0]?.href, "/dashboard/records/cin_029a67a16d8a252f6e3eb896/accounts/1212486749");
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
  relationships: [{ name: "account", stream: "accounts", foreign_key: "account_id", cardinality: "has_one" }],
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
  assert.equal(link.href, "/dashboard/records/cin_029a67a16d8a252f6e3eb896/accounts/1212486749");
});

test("child-declared has_one percent-encodes connection, stream, and key value", () => {
  const links = childHasOneBackLinksFromManifest(
    {
      name: "items",
      relationships: [{ name: "order", stream: "open orders", foreign_key: "order id", cardinality: "has_one" }],
    },
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
      relationships: [{ name: "tags", stream: "tags", foreign_key: "transaction_id", cardinality: "has_many" }],
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
      { name: "tags", stream: "tags", foreign_key: "transaction_id", cardinality: "has_many" },
      { name: "account", stream: "accounts", cardinality: "has_one" }, // missing foreign_key
      { name: "owner", foreign_key: "owner_id", cardinality: "has_one" }, // missing stream
      { name: "category", stream: "categories", foreign_key: "category_id", cardinality: "has_one" },
    ],
  });
  assert.deepEqual([...fields], ["category_id"]);
  assert.deepEqual([...childHasOneLinkFields(undefined)], []);
  assert.deepEqual([...childHasOneLinkFields({ name: "x" })], []);
});

test("childHasOneBackLinkForField links a declared has_one cell to the parent record", () => {
  const link = childHasOneBackLinkForField(
    CHASE_TRANSACTIONS_MANIFEST_STREAM,
    { id: "tx1", account_id: "1212486749", amount: -1234 },
    "account_id",
    { connectionId: "cin_chase" }
  );
  assert.ok(link);
  assert.equal(link.parentStream, "accounts");
  assert.equal(link.childParentKeyField, "account_id");
  assert.equal(link.href, "/dashboard/records/cin_chase/accounts/1212486749");
});

test("childHasOneBackLinkForField resolves each field of a two-edges-to-same-parent stream independently", () => {
  // YNAB transactions: account_id and transfer_account_id are different columns
  // and resolve to DIFFERENT account records — the list page links each cell.
  const record = { id: "t1", account_id: "acc-A", transfer_account_id: "acc-B" };
  const a = childHasOneBackLinkForField(YNAB_TRANSACTIONS_TWO_ACCOUNT_EDGES, record, "account_id", {
    connectionId: "cin_ynab",
  });
  const b = childHasOneBackLinkForField(YNAB_TRANSACTIONS_TWO_ACCOUNT_EDGES, record, "transfer_account_id", {
    connectionId: "cin_ynab",
  });
  assert.equal(a?.href, "/dashboard/records/cin_ynab/accounts/acc-A");
  assert.equal(b?.href, "/dashboard/records/cin_ynab/accounts/acc-B");
  assert.notEqual(a?.href, b?.href);
});

test("childHasOneBackLinkForField percent-encodes connection, parent stream, and value", () => {
  const link = childHasOneBackLinkForField(
    {
      name: "items",
      relationships: [{ name: "order", stream: "open orders", foreign_key: "order id", cardinality: "has_one" }],
    },
    { "order id": "ref/42" },
    "order id",
    { connectionId: "my conn" }
  );
  assert.equal(link?.href, "/dashboard/records/my%20conn/open%20orders/ref%2F42");
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
    childHasOneBackLinkForField(CHASE_TRANSACTIONS_MANIFEST_STREAM, { id: "tx1", account_id: "" }, "account_id", {
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
    relationships: [{ name: "account", stream: "accounts", foreign_key: "account_id", cardinality: "has_one" }],
  },
];

test("Chase accounts parent yields a transactions filtered-list link, never a detail URL", () => {
  const links = reverseChildListLinksFromManifest(CHASE_STREAMS, {
    connectionId: "cin_029a67a16d8a252f6e3eb896",
    parentStream: "accounts",
    parentRecordKey: "1212486749",
  });
  assert.equal(links.length, 1);
  const link = links[0];
  assert.ok(link);
  assert.equal(link.childStream, "transactions");
  assert.equal(link.foreignKey, "account_id");
  // Filtered child LIST, keyed by the parent key as the filter value.
  assert.equal(
    link.href,
    "/dashboard/records/cin_029a67a16d8a252f6e3eb896/transactions?filter[account_id]=1212486749"
  );
  // Must NOT build a `.../transactions/<accountKey>` child record-detail URL.
  assert.ok(
    !link.href.includes("/transactions/1212486749"),
    "must not build a child detail URL from the parent key"
  );
});

test("reverse link is a filtered list URL with a filter[…] query, never a detail segment", () => {
  const [link] = reverseChildListLinksFromManifest(CHASE_STREAMS, {
    connectionId: "chase",
    parentStream: "accounts",
    parentRecordKey: "acc1",
  });
  assert.ok(link);
  // The path part ends at the child stream; the parent key is only in the query.
  const [path, query] = link.href.split("?");
  assert.equal(path, "/dashboard/records/chase/transactions");
  assert.equal(query, "filter[account_id]=acc1");
});

test("a child-declared has_many produces no reverse link", () => {
  const streams = [
    { name: "transactions" },
    {
      name: "tags",
      // has_many back to the parent — must NOT yield a reverse link by this rule.
      relationships: [{ name: "transaction", stream: "transactions", foreign_key: "transaction_id", cardinality: "has_many" }],
    },
  ];
  assert.deepEqual(
    reverseChildListLinksFromManifest(streams, {
      connectionId: "conn",
      parentStream: "transactions",
      parentRecordKey: "tx1",
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
    parentStream: "merchants",
    parentRecordKey: "m1",
  });
  assert.deepEqual(links, []);
});

test("a child has_one without a foreign_key produces no reverse link", () => {
  const streams = [
    { name: "accounts" },
    { name: "transactions", relationships: [{ name: "account", stream: "accounts", cardinality: "has_one" }] },
  ];
  assert.deepEqual(
    reverseChildListLinksFromManifest(streams, {
      connectionId: "chase",
      parentStream: "accounts",
      parentRecordKey: "a1",
    }),
    []
  );
});

test("reverse link percent-encodes connection, child stream, filter field, and parent key", () => {
  const streams = [
    { name: "open orders" },
    {
      name: "line items",
      relationships: [{ name: "order", stream: "open orders", foreign_key: "order id", cardinality: "has_one" }],
    },
  ];
  const [link] = reverseChildListLinksFromManifest(streams, {
    connectionId: "my conn",
    parentStream: "open orders",
    parentRecordKey: "ref/42",
  });
  assert.ok(link);
  assert.equal(link.href, "/dashboard/records/my%20conn/line%20items?filter[order%20id]=ref%2F42");
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
      parentStream: "accounts",
      parentRecordKey: "a1",
    });
    assert.equal(links.length, 1);
    assert.equal(links[0]?.href, "/dashboard/records/cin_live/transactions?filter[account_id]=a1");
  }
});

test("reverse link deduplicates against a forward has_many target on the same child stream and field", () => {
  // A parent that both advertises a has_many expand_capability AND has a child
  // declaring has_one back to it must render a SINGLE link, not two.
  const forwardLinks = buildRelatedLinks(
    [
      {
        name: "transactions",
        stream: "transactions",
        target_stream: "transactions",
        cardinality: "has_many",
        child_parent_key_field: "account_id",
        foreign_key: "account_id",
        granted: true,
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
    { connectionId: "chase", parentStream: "accounts", parentRecordKey: "a1" },
    forwardKeys
  );
  // Forward already covers (transactions, account_id) → reverse suppresses it.
  assert.deepEqual(reverse, []);
});

test("reverse link is kept when a forward has_many targets a different child stream or field", () => {
  const forwardKeys = new Set([reverseChildListDedupKey("other_stream", "account_id")]);
  const reverse = reverseChildListLinksFromManifest(
    CHASE_STREAMS,
    { connectionId: "chase", parentStream: "accounts", parentRecordKey: "a1" },
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
        { name: "account", stream: "accounts", foreign_key: "account_id", cardinality: "has_one" },
        { name: "owning_account", stream: "accounts", foreign_key: "account_id", cardinality: "has_one" },
      ],
    },
  ];
  const links = reverseChildListLinksFromManifest(streams, {
    connectionId: "chase",
    parentStream: "accounts",
    parentRecordKey: "a1",
  });
  assert.equal(links.length, 1);
});

test("reverseChildListLinksFromManifest returns empty for missing streams or args", () => {
  assert.deepEqual(
    reverseChildListLinksFromManifest(undefined, { connectionId: "c", parentStream: "accounts", parentRecordKey: "a1" }),
    []
  );
  assert.deepEqual(
    reverseChildListLinksFromManifest(CHASE_STREAMS, { connectionId: "c", parentStream: "", parentRecordKey: "a1" }),
    []
  );
  assert.deepEqual(
    reverseChildListLinksFromManifest(CHASE_STREAMS, { connectionId: "c", parentStream: "accounts", parentRecordKey: "" }),
    []
  );
});

test("reverseChildListDedupKey is stable and distinguishes stream from field", () => {
  assert.equal(reverseChildListDedupKey("transactions", "account_id"), reverseChildListDedupKey("transactions", "account_id"));
  assert.notEqual(
    reverseChildListDedupKey("transactions", "account_id"),
    reverseChildListDedupKey("transactions", "merchant_id")
  );
  assert.notEqual(
    reverseChildListDedupKey("transactions", "account_id"),
    reverseChildListDedupKey("transfers", "account_id")
  );
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
    { name: "account", stream: "accounts", foreign_key: "account_id", cardinality: "has_one" },
    { name: "transfer_account", stream: "accounts", foreign_key: "transfer_account_id", cardinality: "has_one" },
  ],
};

test("two child-declared has_one edges to the same parent stream via different fields both render", () => {
  const childLinks = childHasOneBackLinksFromManifest(
    YNAB_TRANSACTIONS_TWO_ACCOUNT_EDGES,
    { id: "t1", account_id: "acc-A", transfer_account_id: "acc-B" },
    { connectionId: "cin_ynab" }
  );
  const merged = mergeParentBackLinks(null, childLinks);
  assert.equal(merged.length, 2, "both account edges must survive the merge");
  const byField = new Map(merged.map((l) => [l.childParentKeyField, l]));
  assert.equal(byField.get("account_id")?.href, "/dashboard/records/cin_ynab/accounts/acc-A");
  assert.equal(byField.get("transfer_account_id")?.href, "/dashboard/records/cin_ynab/accounts/acc-B");
  // The two links point at DIFFERENT account records, not the same one.
  assert.notEqual(byField.get("account_id")?.href, byField.get("transfer_account_id")?.href);
});

test("mergeParentBackLinks collapses the SAME edge discovered via both sources", () => {
  // metadata source and child-declared source describe the same (accounts,
  // account_id) edge → one link, metadata-derived preferred.
  const metadata: ParentBackLink = {
    parentStream: "accounts",
    childParentKeyField: "account_id",
    href: "/dashboard/records/cin/accounts/acc-A",
  };
  const childDeclared = childHasOneBackLinksFromManifest(
    CHASE_TRANSACTIONS_MANIFEST_STREAM,
    { id: "t1", account_id: "acc-A" },
    { connectionId: "cin" }
  );
  const merged = mergeParentBackLinks(metadata, childDeclared);
  assert.equal(merged.length, 1, "same (parentStream, field) from both sources collapses to one");
  assert.equal(merged[0], metadata, "the metadata-derived link is preferred");
});

test("mergeParentBackLinks keeps distinct parent streams and is order-stable", () => {
  const childLinks: ParentBackLink[] = [
    { parentStream: "accounts", childParentKeyField: "account_id", href: "/a" },
    { parentStream: "payees", childParentKeyField: "payee_id", href: "/p" },
    { parentStream: "categories", childParentKeyField: "category_id", href: "/c" },
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
  assert.equal(
    parentBackLinkDedupKey("accounts", "account_id"),
    parentBackLinkDedupKey("accounts", "account_id")
  );
  // Same parent stream, different field → distinct keys (the YNAB case).
  assert.notEqual(
    parentBackLinkDedupKey("accounts", "account_id"),
    parentBackLinkDedupKey("accounts", "transfer_account_id")
  );
  // Different parent stream, same field → distinct keys.
  assert.notEqual(
    parentBackLinkDedupKey("accounts", "account_id"),
    parentBackLinkDedupKey("payees", "account_id")
  );
});
