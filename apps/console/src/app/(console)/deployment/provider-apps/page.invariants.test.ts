// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guard for the provider-app deployment config Console page
 * shell (page.tsx) and its server action (actions.ts).
 *
 * The page must never render or serialize an env var name (`env_alias`);
 * must refresh via `revalidatePath` after a save so "already set" state is
 * never stale; and must use plain, owner-facing copy rather than internal
 * "provider apps" language.
 *
 * Field-level and identity-group-vs-provider_identity_label rendering
 * contracts live in group-form.tsx now (GroupForm/FieldInput were extracted
 * out of page.tsx) — see group-form.invariants.test.ts for the structural
 * checks and identity-display.test.ts for the rendered-DOM proof that
 * identity_group never leaks into visible copy.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const ACTIONS_FILE = `${HERE}actions.ts`;
const REF_CLIENT_FILE = `${HERE}../../lib/ref-client.ts`;

const ENV_ALIAS_RE = /env_alias/;
const REVALIDATE_PATH_RE = /revalidatePath\(PAGE_PATH\)/;
const DASHBOARD_ACCESS_RE = /requireDashboardAccess\(PAGE_PATH\)/;
const PROVIDER_APP_CONFIG_FIELD_INTERFACE_RE = /export interface ProviderAppConfigField \{[\s\S]*?\n\}/;
const PROVIDER_APP_CONFIG_GROUP_LABEL_RE = /provider_identity_label: string/;
const PLAIN_LANGUAGE_TITLE_RE = /title="Set up provider access"/;
const NO_INTERNAL_PROVIDER_APPS_COPY_RE = /Provider apps/;
const NO_AUTHORIZE_ON_BEHALF_COPY_RE = /authorize on this deployment's behalf/;

test("provider-app config page never renders an env var alias", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, ENV_ALIAS_RE);
});

test("provider-app config server actions never reference an env var alias", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.doesNotMatch(src, ENV_ALIAS_RE);
});

test("provider-app config ref-client types never expose env_alias", async () => {
  const src = await readFile(REF_CLIENT_FILE, "utf8");
  // The full ref-client file legitimately discusses "env" in unrelated
  // contexts (process.env plumbing for other features) — this test only
  // proves the provider-app config section specifically carries no
  // `env_alias` field on its response/request shapes.
  const groupInterfaceMatch = src.match(PROVIDER_APP_CONFIG_FIELD_INTERFACE_RE);
  assert.ok(groupInterfaceMatch, "ProviderAppConfigField interface not found");
  assert.doesNotMatch(groupInterfaceMatch[0], ENV_ALIAS_RE);
});

test("provider-app config ref-client group type carries a human-facing identity label", async () => {
  const src = await readFile(REF_CLIENT_FILE, "utf8");
  assert.match(src, PROVIDER_APP_CONFIG_GROUP_LABEL_RE);
});

test("provider-app config save action revalidates the page after a write", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, REVALIDATE_PATH_RE);
});

test("provider-app config save action re-verifies the owner session", async () => {
  const src = await readFile(ACTIONS_FILE, "utf8");
  assert.match(src, DASHBOARD_ACCESS_RE);
});

test("provider-app config page uses plain external copy, not internal 'provider apps' language", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, PLAIN_LANGUAGE_TITLE_RE);
  assert.doesNotMatch(src, NO_INTERNAL_PROVIDER_APPS_COPY_RE);
  assert.doesNotMatch(src, NO_AUTHORIZE_ON_BEHALF_COPY_RE);
});
