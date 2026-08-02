// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecordRoutePath, buildStreamRoutePath, dashboardRoutes, sandboxRoutes } from "./routes.ts";

test("dashboard record routes use the canonical /sources detail destination", () => {
  const recordId = "1872345373857054938:2.2";
  const href = dashboardRoutes.record("cin_12407c1afb78d56848fe0b20", "attachments", recordId);

  assert.equal(href, "/sources/cin_12407c1afb78d56848fe0b20/attachments/1872345373857054938%3A2.2");
  assert.equal(href.includes("/records/"), false);
  assert.equal(href.includes("%253A"), false);
});

test("shared route builders encode each reserved path value exactly once", () => {
  const recordsBasePath = dashboardRoutes.section.records;
  const connectionId = "cin personal/42";
  const stream = "attachments/raw";
  const recordId = "part:2.2#latest?view=full";

  assert.equal(
    buildRecordRoutePath(recordsBasePath, connectionId, stream, recordId),
    "/sources/cin%20personal%2F42/attachments%2Fraw/part%3A2.2%23latest%3Fview%3Dfull"
  );
  assert.equal(
    buildStreamRoutePath(recordsBasePath, connectionId, stream),
    "/sources/cin%20personal%2F42/attachments%2Fraw"
  );
});

test("sandbox keeps its own records section while sharing the path contract", () => {
  assert.equal(sandboxRoutes.section.records, "/sandbox/records");
  assert.equal(
    sandboxRoutes.record("conn/1", "messages/threads", "id:2"),
    "/sandbox/records/conn%2F1/messages%2Fthreads/id%3A2"
  );
});
