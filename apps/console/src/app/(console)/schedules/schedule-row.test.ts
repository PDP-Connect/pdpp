// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROW_FILE = `${HERE}schedule-row.tsx`;

const CONNECTION_TARGET = /summary\.connection_id \?\? summary\.connector_instance_id \?\? null/;
const UPSERT_RECEIVES_CONNECTION =
  /upsertScheduleAction\(summary\.connector_id,[\s\S]*connectionId: summary\.connection_id \?\? summary\.connector_instance_id \?\? null/;
const PAUSE_RECEIVES_CONNECTION =
  /pauseScheduleAction\(\s*summary\.connector_id,\s*summary\.connection_id \?\? summary\.connector_instance_id \?\? null\s*\)/;
const RESUME_RECEIVES_CONNECTION =
  /resumeScheduleAction\(\s*summary\.connector_id,\s*summary\.connection_id \?\? summary\.connector_instance_id \?\? null\s*\)/;
const DELETE_RECEIVES_CONNECTION =
  /deleteScheduleAction\(\s*summary\.connector_id,\s*summary\.connection_id \?\? summary\.connector_instance_id \?\? null\s*\)/;

test("schedule-row mutates the concrete connection when one is present", async () => {
  const src = await readFile(ROW_FILE, "utf8");
  assert.match(src, CONNECTION_TARGET);
  assert.match(src, UPSERT_RECEIVES_CONNECTION);
  assert.match(src, PAUSE_RECEIVES_CONNECTION);
  assert.match(src, RESUME_RECEIVES_CONNECTION);
  assert.match(src, DELETE_RECEIVES_CONNECTION);
});
