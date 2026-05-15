import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSlackdumpMissingError, runSlackdump } from "./index.ts";

test("formatSlackdumpMissingError: describes path contract and Docker remediation", () => {
  const message = formatSlackdumpMissingError("/opt/bin/slackdump");

  assert.match(message, /slackdump binary not found: \/opt\/bin\/slackdump/);
  assert.match(message, /SLACKDUMP_BIN/);
  assert.match(message, /PATH/);
  assert.match(message, /stock reference image does not bundle/);
});

test("runSlackdump: maps ENOENT to actionable missing-binary guidance", async () => {
  const prior = process.env.SLACKDUMP_BIN;
  process.env.SLACKDUMP_BIN = "/definitely/missing/slackdump";

  try {
    await assert.rejects(
      runSlackdump(["--help"], { env: process.env, timeoutMs: 1000 }),
      /slackdump binary not found: \/definitely\/missing\/slackdump/
    );
  } finally {
    if (prior === undefined) {
      delete process.env.SLACKDUMP_BIN;
    } else {
      process.env.SLACKDUMP_BIN = prior;
    }
  }
});
