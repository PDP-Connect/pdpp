import assert from "node:assert/strict";
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseCSVFile } from "./parsers.ts";

test("parseCSVFile rejects file exceeding 50 MiB limit", async () => {
  const tmpDir = "/tmp/netflix-test-oversized";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "oversized.csv");

    // Create a file that's 50 MiB + 1 byte (header is 17 bytes)
    const FIFTY_MIB = 50 * 1024 * 1024;
    const fd = openSync(csvPath, "w");
    writeSync(fd, "Title,Watched at\n");
    writeSync(fd, "a".repeat(FIFTY_MIB - 17 + 1)); // Pad to exceed limit by 1
    closeSync(fd);

    const result = await parseCSVFile(csvPath);
    assert.ok(result.error, `Should error on oversized file, got: ${JSON.stringify(result)}`);
    assert.ok(result.error?.includes("exceeds maximum size"), "Error message should mention size limit");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
