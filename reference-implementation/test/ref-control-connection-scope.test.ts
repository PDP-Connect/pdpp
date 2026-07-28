// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REF_CONTROL = fileURLToPath(new URL("../server/ref-control.ts", import.meta.url));
const CONNECTION_SCOPED_SCHEDULE_CALL = /getScheduleFrom\(controller, connectorId, \{ connectorInstanceId \}\)/;
const CONNECTION_SCOPED_SCHEDULE_TYPE =
  /getSchedule(?:: \(|\()connectorId: string, options\?: \{ readonly connectorInstanceId\?: string \}\)/;

test("connector summaries read schedule evidence through connector_instance_id", async () => {
  const src = await readFile(REF_CONTROL, "utf8");
  assert.match(
    src,
    CONNECTION_SCOPED_SCHEDULE_CALL,
    "listConnectorSummaries must not read schedule evidence by connector type when rendering connection rows"
  );
  assert.match(
    src,
    CONNECTION_SCOPED_SCHEDULE_TYPE,
    "controller schedule dependency must expose connection-scoped schedule lookup"
  );
});
