// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The owner-token UAT path crosses a browser form, a Next Server Action, and
 * the AS's owner-session DCR route. Keep the wiring contract visible here;
 * the reference-implementation route test proves the resulting HTTP flow.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const ACTIONS_FILE = `${HERE}actions.ts`;
const BOOTSTRAP_FILE = fileURLToPath(new URL("../../lib/operator-bootstrap.ts", import.meta.url));

const ISSUE_FORM_RE = /<form action=\{issueOwnerTokenAction\}/;
const ISSUE_ACTION_RE = /export async function issueOwnerTokenAction/;
const DASHBOARD_ACCESS_RE = /await requireDashboardAccess\("\/deployment\/tokens"\);/;
const START_FLOW_RE = /startOwnerBootstrapFlow\(undefined, name\)/;
const OWNER_COOKIE_RE = /withOwnerSessionCookie/;
const JSON_REQUEST_RE = /"Content-Type": "application\/json"/;
const LOCAL_BEARER_IMPORT_RE = /DEFAULT_DCR_INITIAL_ACCESS_TOKEN/;
const LOCAL_BEARER_HEADER_RE = /Authorization:\s*`Bearer \$\{DEFAULT_DCR_INITIAL_ACCESS_TOKEN\}`/;

test("deployment token issuance keeps the form, Server Action, and owner-session DCR wiring aligned", async () => {
  const [page, actions, bootstrap] = await Promise.all([
    readFile(PAGE_FILE, "utf8"),
    readFile(ACTIONS_FILE, "utf8"),
    readFile(BOOTSTRAP_FILE, "utf8"),
  ]);

  assert.match(page, ISSUE_FORM_RE);
  assert.match(actions, ISSUE_ACTION_RE);

  const issueActionStart = actions.search(ISSUE_ACTION_RE);
  const issueActionEnd = actions.indexOf("\nexport async function approveOwnerTokenFlowAction", issueActionStart);
  assert.ok(issueActionEnd > issueActionStart, "the composite issuing action must have a bounded source body");
  const issueAction = actions.slice(issueActionStart, issueActionEnd);
  const accessIndex = issueAction.search(DASHBOARD_ACCESS_RE);
  const startIndex = issueAction.search(START_FLOW_RE);
  assert.ok(accessIndex >= 0, "the issuing Server Action must re-check dashboard access");
  assert.ok(startIndex > accessIndex, "dashboard access must be checked before the BFF starts the mint flow");

  assert.match(bootstrap, OWNER_COOKIE_RE);
  assert.match(bootstrap, JSON_REQUEST_RE);
  assert.doesNotMatch(bootstrap, LOCAL_BEARER_IMPORT_RE);
  assert.doesNotMatch(bootstrap, LOCAL_BEARER_HEADER_RE);
});
