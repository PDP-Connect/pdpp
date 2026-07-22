// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const ROOT_PROXY_ROUTES = ["consent", "device", "owner"] as const;

test("console exposes bare hosted-UI proxy routes", () => {
  for (const route of ROOT_PROXY_ROUTES) {
    assert.equal(
      existsSync(`apps/console/src/app/${route}/route.ts`),
      true,
      `apps/console must expose /${route}; catch-all routes do not match the bare path`
    );
  }
});
