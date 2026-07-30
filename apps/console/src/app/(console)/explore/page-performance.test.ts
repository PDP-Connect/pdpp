// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Default Explore is session-gated but does not need an RS bearer. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const DEFAULT_EXPLORE_FUNCTION = "export default async function RecordsExplorerPage";
const VERIFY_DASHBOARD_SESSION_AWAIT = /await verifyDashboardSession\(\)/;
const OWNER_TOKEN_AWAIT = /await getOwnerToken\(\)/;

test("default Explore verifies the owner session without eagerly minting an owner bearer", async () => {
  const source = await readFile(PAGE_FILE, "utf8");
  const routeBody = source.slice(source.indexOf(DEFAULT_EXPLORE_FUNCTION));

  assert.match(routeBody, VERIFY_DASHBOARD_SESSION_AWAIT);
  assert.doesNotMatch(
    routeBody,
    OWNER_TOKEN_AWAIT,
    "RS-specific owner bearer minting belongs to the data-source method that needs it, not default first paint"
  );
});
