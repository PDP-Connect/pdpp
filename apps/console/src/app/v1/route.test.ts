// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_FILE = path.join(HERE, "[...path]", "route.ts");

test("console /v1 catch-all forwards mutating resource-server methods", () => {
  const source = readFileSync(ROUTE_FILE, "utf8");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.match(
      source,
      new RegExp(`export\\s+const\\s+${method}\\s*=\\s*GET`),
      `/v1 catch-all must export ${method}; otherwise Next returns 405 before the reference server sees the request`
    );
  }
});
