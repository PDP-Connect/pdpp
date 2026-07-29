// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PAGE_ROUTES } from "./bench.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONSOLE_APP_DIR = join(SCRIPT_DIR, "..", "..", "apps", "console", "src", "app", "(console)");

test("benchmark page routes use current console paths, not the retired dashboard prefix", () => {
  for (const route of PAGE_ROUTES) {
    assert.ok(!route.startsWith("/dashboard"), `route ${route} still uses the retired /dashboard prefix`);
  }
});

test("each benchmark page route begins at a current console route segment", () => {
  for (const route of PAGE_ROUTES) {
    if (route === "/") {
      continue;
    }
    const segment = route.split("?", 1)[0]?.replace(/^\//, "").split("/", 1)[0];
    assert.ok(segment, `route ${route} must contain a console route segment`);
    assert.ok(
      existsSync(join(CONSOLE_APP_DIR, segment)),
      `route ${route} has no matching apps/console/src/app/(console)/${segment} directory`
    );
  }
});
