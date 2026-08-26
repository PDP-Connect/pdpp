// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isSlackMessageTombstone } from "./index.ts";

const INDEX_SOURCE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("Slack production entrypoint wires the deletion predicate into the runtime", () => {
  assert.match(
    INDEX_SOURCE,
    /runConnector\(\{[\s\S]*?isTombstone:\s*isSlackMessageTombstone/u,
    "Slack must opt into runtime delete envelopes"
  );
});

test("exact Slack tombstone marker emits a delete, while ordinary records do not", () => {
  assert.equal(isSlackMessageTombstone("messages", { id: "m1", is_tombstone: true }), true);
  assert.equal(isSlackMessageTombstone("messages", { id: "m1", is_tombstone: false }), false);
  assert.equal(isSlackMessageTombstone("reactions", { id: "m1", is_tombstone: true }), false);
});
