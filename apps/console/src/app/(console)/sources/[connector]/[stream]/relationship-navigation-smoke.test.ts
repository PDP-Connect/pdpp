/**
 * Relationship-navigation smoke — proves both directions resolve to the correct,
 * percent-encoded hrefs against the REAL bundled Chase manifest, and pins the two
 * records `page.tsx` server components to the helper composition that produces
 * those hrefs.
 *
 * Why this exists on top of `lib/relationships.test.ts` (52 cases): those tests
 * exercise each helper in isolation with hand-built inputs. They do NOT prove
 * that the *composition* the pages perform — meta + child-declared back-link
 * merge on the detail page, the `hasReverseChildEdges` gate then per-row reverse
 * links on the list page — yields the right href when run against a real
 * connector manifest. And because both pages are React Server Components that
 * import `next/navigation`, they cannot be rendered in a plain node test, so the
 * JSX call sites were previously guarded only by `types:check`. This file closes
 * that gap two ways:
 *
 *   1. Behavior: replicate each page's exact helper call chain against the real
 *      Chase manifest read from disk (the same file `listConnectorManifests()`
 *      loads) and assert the resulting hrefs.
 *   2. Wiring: source-pin both `page.tsx` files to the helper calls and render
 *      sites, mirroring the sibling `page-record-not-found.test.ts` /
 *      `page-stream-unavailable.test.ts` pattern, so a refactor that drops or
 *      mis-orders a call is caught even though the page can't be imported.
 *
 * No network, no credentials. The bidirectional pair under test is the exact one
 * the owner asked about: a Chase transaction -> its account, and an account ->
 * its transactions.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  candidateParentStreamsForChild,
  childHasOneBackLinksFromManifest,
  findManifestForConnectorId,
  findParentBackLink,
  mergeParentBackLinks,
  parentRelationsForChild,
  reverseChildListEdgesFromManifest,
  reverseChildListLinksFromManifest,
} from "../../lib/relationships.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// .../sources/[connector]/[stream]/ -> repo root is six levels up from console
// src; resolve via the manifests dir the console itself reads.
const CHASE_MANIFEST = fileURLToPath(
  new URL("../../../../../../../../packages/polyfill-connectors/manifests/chase.json", import.meta.url)
);
const DETAIL_PAGE = fileURLToPath(new URL("[recordKey]/page.tsx", `file://${HERE}`));
const LIST_PAGE = `${HERE}page.tsx`;

// A reference connection reports the SHORT connector key, not the URL-form id.
const CONNECTION_CONNECTOR_ID = "chase";
const CONNECTION_ID = "cin_smoke_chase";
const ACCOUNT_KEY = "1212486749";

interface ManifestStream {
  name: string;
  query?: { expand?: Array<{ name: string }> };
  relationships?: Array<{ name: string; stream?: string; foreign_key?: string; cardinality?: string }>;
}
interface ChaseManifest {
  connector_id?: string;
  connector_key?: string;
  streams?: ManifestStream[];
}

// Source-pin regexes for the wiring tests, hoisted to module scope per the
// project's `useTopLevelRegex` lint rule (and the sibling
// `page-record-not-found.test.ts` convention).
const DETAIL_RESOLVES_META_BACKLINK = /findParentBackLink\(/;
const DETAIL_RESOLVES_CHILD_BACKLINK = /childHasOneBackLinksFromManifest\(/;
const DETAIL_MERGES_BACKLINKS = /mergeParentBackLinks\(/;
const DETAIL_RENDERS_BACKLINKS = /allParentBackLinks\.map\(/;
const DETAIL_BUILDS_REVERSE_LINKS = /reverseChildListLinksFromManifest\(/;
const DETAIL_RENDERS_REVERSE_LINKS = /reverseChildListLinks\.map\(/;
const LIST_COMPUTES_LINK_FIELDS = /childHasOneLinkFields\(/;
const LIST_RESOLVES_CELL_BACKLINK = /childHasOneBackLinkForField\(/;
const LIST_APPLIES_CELL_LINK = /parentLinkForCell\(/;
const LIST_GATES_REVERSE_EDGES = /reverseChildListEdgesFromManifest\(/;
const LIST_BUILDS_REVERSE_LINKS = /reverseChildListLinksFromManifest\(/;
const LIST_GUARDS_REVERSE_COLUMN = /hasReverseChildEdges/;

async function loadChaseManifest(): Promise<ChaseManifest> {
  return JSON.parse(await readFile(CHASE_MANIFEST, "utf8")) as ChaseManifest;
}

test("the real Chase manifest declares the bidirectional transactions<->accounts edge this smoke depends on", async () => {
  const manifest = await loadChaseManifest();
  const connectorManifest = findManifestForConnectorId([manifest], CONNECTION_CONNECTOR_ID);
  assert.ok(connectorManifest, "Chase manifest must resolve from the short connector key, not just the URL-form id");
  const tx = connectorManifest.streams?.find((s) => s.name === "transactions");
  const rel = tx?.relationships?.find((r) => r.stream === "accounts");
  assert.ok(rel, "Chase transactions must declare a relationship to accounts");
  assert.equal(rel?.cardinality, "has_one");
  assert.equal(rel?.foreign_key, "account_id");
});

test("DIRECTION 1 transaction -> account: detail-page chain yields the parent account detail href", async () => {
  const manifest = await loadChaseManifest();
  const connectorManifest = findManifestForConnectorId([manifest], CONNECTION_CONNECTOR_ID);
  assert.ok(connectorManifest);
  const streamName = "transactions";
  const childManifestStream = connectorManifest.streams?.find((s) => s.name === streamName);
  const recordData = { account_id: ACCOUNT_KEY, amount: -42.5, description: "Coffee" };

  // Replicate [recordKey]/page.tsx exactly: Chase declares no parent
  // `query.expand`, so the metadata source is empty and the only back-link comes
  // from the child's own declared `has_one`. The page merges them, deduped by
  // (parentStream, field).
  const candidates = candidateParentStreamsForChild(connectorManifest.streams, streamName);
  const parentRelations = parentRelationsForChild(
    candidates.map((parentStream) => ({ parentStream, expandCapabilities: [] })),
    streamName
  );
  const parentBackLinkFromMeta = findParentBackLink(streamName, recordData, parentRelations, {
    connectionId: CONNECTION_ID,
  });
  const childHasOneLinks = childHasOneBackLinksFromManifest(childManifestStream, recordData, {
    connectionId: CONNECTION_ID,
  });
  const allParentBackLinks = mergeParentBackLinks(parentBackLinkFromMeta, childHasOneLinks);

  assert.equal(parentBackLinkFromMeta, null, "Chase has no parent expand metadata, so the metadata source is null");
  assert.equal(allParentBackLinks.length, 1, "exactly one transaction -> account back-link must render");
  const link = allParentBackLinks[0];
  assert.equal(link?.parentStream, "accounts");
  assert.equal(link?.childParentKeyField, "account_id");
  assert.equal(
    link?.href,
    `/sources/${CONNECTION_ID}/accounts/${ACCOUNT_KEY}`,
    "transaction -> account must link to the parent account's detail page"
  );
});

test("DIRECTION 2 account -> transactions: list-page chain yields the filtered child-list href", async () => {
  const manifest = await loadChaseManifest();
  const connectorManifest = findManifestForConnectorId([manifest], CONNECTION_CONNECTOR_ID);
  assert.ok(connectorManifest);
  const connectorStreams = connectorManifest.streams ?? [];
  const parentStream = "accounts";

  // Replicate [stream]/page.tsx for the parent (accounts) list: gate on the
  // reverse child-edge set, then build per-row filtered child-list links.
  const edges = reverseChildListEdgesFromManifest(connectorStreams, parentStream);
  assert.ok(edges.length > 0, "accounts must have reverse child edges — the list-page gate that renders the column");

  const reverseLinks = reverseChildListLinksFromManifest(connectorStreams, {
    connectionId: CONNECTION_ID,
    parentStream,
    parentRecordKey: ACCOUNT_KEY,
  });
  assert.equal(reverseLinks.length, edges.length, "one reverse link per declared child has_one edge");

  const toTransactions = reverseLinks.find((l) => l.childStream === "transactions");
  assert.ok(toTransactions, "accounts -> transactions reverse link must be present");
  assert.equal(toTransactions?.foreignKey, "account_id");
  assert.equal(
    toTransactions?.href,
    `/sources/${CONNECTION_ID}/transactions?filter[account_id]=${ACCOUNT_KEY}`,
    "account -> transactions must be the filtered child list, never a child-detail URL"
  );
});

test("ROUND-TRIP: the account key is the shared join value both directions use", async () => {
  const manifest = await loadChaseManifest();
  const connectorManifest = findManifestForConnectorId([manifest], CONNECTION_CONNECTOR_ID);
  assert.ok(connectorManifest);
  const connectorStreams = connectorManifest.streams ?? [];
  const txStream = connectorStreams.find((s) => s.name === "transactions");

  const up = childHasOneBackLinksFromManifest(
    txStream,
    { account_id: ACCOUNT_KEY },
    { connectionId: CONNECTION_ID }
  )[0];
  const down = reverseChildListLinksFromManifest(connectorStreams, {
    connectionId: CONNECTION_ID,
    parentStream: "accounts",
    parentRecordKey: ACCOUNT_KEY,
  }).find((l) => l.childStream === "transactions");

  assert.ok(up?.href.endsWith(`/accounts/${ACCOUNT_KEY}`), "ascending lands on exactly that account");
  assert.ok(down?.href.includes(`filter[account_id]=${ACCOUNT_KEY}`), "descending filters children by that account");
});

// ---- Wiring source-pins: the RSC page.tsx files cannot be imported (they pull
// in next/navigation), so pin the helper composition the behavior tests above
// rely on. A refactor that drops or mis-wires one of these is caught here even
// though it would still type-check. ----

test("WIRING detail page composes the child->parent back-link merge it renders", async () => {
  const src = await readFile(DETAIL_PAGE, "utf8");
  assert.match(src, DETAIL_RESOLVES_META_BACKLINK, "detail page must resolve the metadata back-link source");
  assert.match(src, DETAIL_RESOLVES_CHILD_BACKLINK, "detail page must resolve the child-declared back-link source");
  assert.match(src, DETAIL_MERGES_BACKLINKS, "detail page must merge the two back-link sources");
  // The merged set is rendered as a parent-link list item.
  assert.match(src, DETAIL_RENDERS_BACKLINKS, "detail page must render the merged back-links");
});

test("WIRING detail page composes the reverse parent->child-list links it renders", async () => {
  const src = await readFile(DETAIL_PAGE, "utf8");
  assert.match(src, DETAIL_BUILDS_REVERSE_LINKS, "detail page must build reverse child-list links");
  assert.match(src, DETAIL_RENDERS_REVERSE_LINKS, "detail page must render the reverse child-list links");
});

test("WIRING list page resolves per-cell child->parent links it renders", async () => {
  const src = await readFile(LIST_PAGE, "utf8");
  assert.match(src, LIST_COMPUTES_LINK_FIELDS, "list page must compute child-declared linkable fields");
  assert.match(src, LIST_RESOLVES_CELL_BACKLINK, "list page must resolve a child-declared back-link per cell");
  assert.match(src, LIST_APPLIES_CELL_LINK, "list page must apply the per-cell parent link in the row");
});

test("WIRING list page gates and renders per-row reverse parent->child-list links", async () => {
  const src = await readFile(LIST_PAGE, "utf8");
  assert.match(src, LIST_GATES_REVERSE_EDGES, "list page must gate the reverse column on declared edges");
  assert.match(src, LIST_BUILDS_REVERSE_LINKS, "list page must build per-row reverse child-list links");
  assert.match(src, LIST_GUARDS_REVERSE_COLUMN, "list page must only render the reverse column when edges exist");
});
