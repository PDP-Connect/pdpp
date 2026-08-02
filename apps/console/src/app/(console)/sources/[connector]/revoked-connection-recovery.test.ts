// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const ACTIONS_FILE = `${HERE}actions.ts`;
const PAGE_REACTIVATE_ACTION_RE = /reactivateConnectionAction/;
const HEADER_REACTIVATE_FORM_RE = /<form action=\{reactivateConnectionAction\}>/;
const HEADER_NEW_CONNECTION_RE = /addSourceHrefForConnector/;
const SECTION_REACTIVATE_FORM_RE = /<form action=\{reactivateConnectionAction\}/;
const SECTION_CONNECTION_ID_RE = /name="connection_id" type="hidden" value=\{connectionId\}/;
const SECTION_PRESERVATION_RE = /records, grants, schedules, and history are preserved/i;
const SECTION_NEW_CONNECTION_LABEL_RE = /Create a new connection/;
const SECTION_NEW_CONNECTION_HREF_RE = /addSourceHrefForConnector\(connectorId\)/;
const SECTION_OLD_COPY_RE = /fresh setup path|Reconnect source/i;
const ACTION_CALL_RE = /await reactivateConnection\(connectionId\)/;
const CREDENTIAL_UPDATE_RE = /credentialUpdate|updateCredential/;

test("revoked detail reactivates the existing connection and labels Add Source as a new connection", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  const revokedSection = page.slice(page.indexOf("function RevokedConnectionSection"));
  const revokedHeader = page.slice(page.indexOf("if (revoked)"), page.indexOf("if (renderedOwnerAction)"));

  assert.match(page, PAGE_REACTIVATE_ACTION_RE);
  assert.match(revokedHeader, HEADER_REACTIVATE_FORM_RE);
  assert.doesNotMatch(revokedHeader, HEADER_NEW_CONNECTION_RE);
  assert.match(revokedSection, SECTION_REACTIVATE_FORM_RE);
  assert.match(revokedSection, SECTION_CONNECTION_ID_RE);
  assert.match(revokedSection, SECTION_PRESERVATION_RE);
  assert.match(revokedSection, SECTION_NEW_CONNECTION_LABEL_RE);
  assert.match(revokedSection, SECTION_NEW_CONNECTION_HREF_RE);
  assert.doesNotMatch(revokedSection, SECTION_OLD_COPY_RE);
});

test("revoked detail reuses reactivation without coupling it to credential update", async () => {
  const actions = await readFile(ACTIONS_FILE, "utf8");
  const reactivateAction = actions.slice(
    actions.indexOf("export async function reactivateConnectionAction"),
    actions.indexOf("export async function deleteConnectionAction")
  );

  assert.match(reactivateAction, ACTION_CALL_RE);
  assert.doesNotMatch(reactivateAction, CREDENTIAL_UPDATE_RE);
});
