import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";

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
