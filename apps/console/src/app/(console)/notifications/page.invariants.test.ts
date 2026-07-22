// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

const WEB_PUSH_SETTINGS_RE = /<WebPushSettings config=\{state\.config\} subscriptions=\{state\.subscriptions\} \/>/;
const WEB_PUSH_CONFIG_RE = /getWebPushConfig\(\)/;
const WEB_PUSH_SUBSCRIPTIONS_RE = /listWebPushSubscriptions\(\)/;
const DEVICE_SCOPED_COPY_RE = /Each device is configured separately/;

test("notifications page renders the Web Push setup surface from live owner state", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, WEB_PUSH_CONFIG_RE);
  assert.match(src, WEB_PUSH_SUBSCRIPTIONS_RE);
  assert.match(src, WEB_PUSH_SETTINGS_RE);
  assert.match(src, DEVICE_SCOPED_COPY_RE);
});
