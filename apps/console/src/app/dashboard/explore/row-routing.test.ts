import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";

// Hoisted per useTopLevelRegex: the LIVE FeedRow row-action source invariants.
// The LIVE Explore component is explore-canvas.tsx (records-explorer-view.tsx is
// a types-only/dead import). On desktop the row body PEEKS (button onClick=onSelect)
// and a SEPARATE Open link routes to the full record-detail href; on mobile the row
// Link navigates to that same full route (R4). The two outcomes differ on desktop.
const MOBILE_ROW_LINK_RE = /className=\{`\$\{rowCls\} rr-x-row--mobile`\}[\s\S]{0,40}href=\{detailHref\}/;
const DESKTOP_ROW_PEEK_BUTTON_RE = /className=\{`\$\{rowCls\} rr-x-row--desktop`\}[\s\S]{0,160}onClick=\{onSelect\}/;
const DESKTOP_OPEN_LINK_RE = /className="rr-x-row-open"[\s\S]{0,40}href=\{detailHref\}/;
// The forbidden meta re-render of the secondary (= rowSecondary, which the shared
// RecordIdentity cell already shows). Its presence = the double-rendered secondary bug.
const META_SECONDARY_SNIPPET_RE = /rr-x-row__snippet-text">\{snippet\}/;

// The view renders <Link href={routes.record(entry.connectionId ?? entry.connectorId, …)}>.
// `resolveConnectionForRecordsRoute` accepts either a connection_id (preferred)
// or a connector_id (falls back to the FIRST matching connection). To avoid
// the route-level guess when we know the concrete connection, the row link
// MUST pass the connection_id segment.

test("row link uses the concrete connection_id when known", () => {
  const entry: { connectionId: string | null; connectorId: string } = {
    connectionId: "conn-work",
    connectorId: "gmail",
  };
  const href = dashboardRoutes.record(entry.connectionId ?? entry.connectorId, "messages", "rec-1");
  assert.equal(href, "/dashboard/records/conn-work/messages/rec-1");
});

test("row link falls back to connector_id when connection identity is genuinely unknown", () => {
  const entry: { connectionId: string | null; connectorId: string } = {
    connectionId: null,
    connectorId: "gmail",
  };
  const href = dashboardRoutes.record(entry.connectionId ?? entry.connectorId, "messages", "rec-1");
  assert.equal(href, "/dashboard/records/gmail/messages/rec-1");
});

test("row link routes two same-connector connections to distinct paths", () => {
  // Regression: prior code passed `entry.connectorId` directly, sending two
  // distinct Gmail connections through the same `/dashboard/records/gmail`
  // path, where `resolveConnectionForRecordsRoute` picks the first match.
  const personalEntry: { connectionId: string | null; connectorId: string } = {
    connectionId: "conn-personal",
    connectorId: "gmail",
  };
  const workEntry: { connectionId: string | null; connectorId: string } = {
    connectionId: "conn-work",
    connectorId: "gmail",
  };
  const personal = dashboardRoutes.record(personalEntry.connectionId ?? personalEntry.connectorId, "messages", "rec-1");
  const work = dashboardRoutes.record(workEntry.connectionId ?? workEntry.connectorId, "messages", "rec-1");
  assert.notEqual(personal, work);
  assert.equal(personal, "/dashboard/records/conn-personal/messages/rec-1");
  assert.equal(work, "/dashboard/records/conn-work/messages/rec-1");
});

// Row-action contract (design.md §6, feedback #12), pinned on the LIVE FeedRow:
//   - Desktop: row body click = PEEK (button onClick=onSelect); a SEPARATE Open
//     link routes to the full record-detail href. Distinct outcomes — Open is
//     never a duplicate of the row click.
//   - Mobile: the row Link navigates to the full record-detail route (R4 — the
//     peek pane is hidden on phones, so ?peek would render nothing).
// PIN: this guards the mobile R4 fix (so a tap never lands on ?peek) and the
// desktop peek-vs-open distinction (so Open never collapses into a row click).
test("LIVE FeedRow: mobile tap routes to the full record detail (R4)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const canvasPath = path.join(here, "explore-canvas.tsx");
  const src = readFileSync(canvasPath, "utf8");
  assert.match(src, MOBILE_ROW_LINK_RE, "mobile row Link must navigate to the full record route via detailHref (R4)");
});

test("LIVE FeedRow: desktop row body peeks; a separate Open routes to the full record (distinct #12)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const canvasPath = path.join(here, "explore-canvas.tsx");
  const src = readFileSync(canvasPath, "utf8");
  assert.match(
    src,
    DESKTOP_ROW_PEEK_BUTTON_RE,
    "desktop row body (button) must open the in-place peek via onClick={onSelect}"
  );
  assert.match(
    src,
    DESKTOP_OPEN_LINK_RE,
    "a SEPARATE desktop 'Open' Link must route to the full record-detail href — distinct from the peek (#12)"
  );
});

// Regression: the secondary line must render EXACTLY ONCE per feed row. The shared
// RecordIdentity cell owns [primary][secondary] (record-components design §row-anatomy);
// the row's meta block must NOT re-render rowSecondary() as a snippet, or the secondary
// double-renders (the live bug: an Amazon cancelled order showed "This order has been
// cancelled" twice — once in rr-x-identity__secondary, once in rr-x-row__snippet-text).
test("LIVE FeedRow: the meta block does NOT re-render the secondary snippet (cell owns it; no double render)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "explore-canvas.tsx"), "utf8");
  // The forbidden re-render: the meta snippet text bound to `snippet` (= rowSecondary)
  // which the RecordIdentity cell already shows.
  assert.doesNotMatch(
    src,
    META_SECONDARY_SNIPPET_RE,
    "the meta block must NOT render {snippet} (rowSecondary) — the RecordIdentity cell already renders the secondary; re-rendering it here double-renders the line"
  );
  // The search-hit Match EXCERPT (a DISTINCT labelled excerpt, search rows only) stays.
  assert.ok(src.includes("matchExcerpt"), "the search-hit Match excerpt path must remain");
});
