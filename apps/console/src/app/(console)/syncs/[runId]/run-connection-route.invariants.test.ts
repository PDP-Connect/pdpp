// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guard: a run must lead back to the source it belongs to.
 *
 * Reported by the owner during live UAT, 2026-08-07: "btw annoying i cant get
 * to the connection/source from its run. not with breadcrumbs or anything
 * else."
 *
 * The page already resolved the connector id from the runtime actor, but
 * rendered it as inert text and breadcrumbed only `Syncs / Sync`. A run was a
 * terminal node: having found the run that collected your data, there was no
 * route to the source that produced it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

// The connector name in the description is a Link, not a bare <span>.
const CONNECTOR_IS_LINK_RE =
  /connector\{" "\}\s*<Link[^>]*href=\{`\/sources\/\$\{encodeURIComponent\(connectorId\)\}`\}/;
// The breadcrumb trail carries the source between Syncs and this run.
const BREADCRUMB_INCLUDES_SOURCE_RE =
  /breadcrumbs=\{[\s\S]*connectorId[\s\S]*href: `\/sources\/\$\{encodeURIComponent\(connectorId\)\}`, label: connectorId/;

test("run detail links its connector back to the source page", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, CONNECTOR_IS_LINK_RE, "the connector id must navigate, not render as inert text");
});

test("run detail breadcrumbs include the source when the connector is known", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, BREADCRUMB_INCLUDES_SOURCE_RE, "breadcrumbs must offer a route back to the source");
});

test("run detail still renders a breadcrumb trail when the connector is unknown", async () => {
  // Not every run resolves a connector (the runtime actor may be absent). That
  // case must degrade to the old two-item trail rather than emitting a link to
  // `/sources/undefined`.
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, /: \[\{ href: dashboardRoutes\.section\.runs, label: "Syncs" \}, \{ label: "Sync" \}\]/);
});
