import assert from "node:assert/strict";
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseCSVFile } from "./parsers.ts";

test("parseCSVFile with file EXACTLY at 50 MiB", async () => {
  const tmpDir = "/tmp/netflix-test-exact";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "exact.csv");

    // Create a file that's EXACTLY 50 MiB (header "Title,Date\n" is 11 bytes)
    const FIFTY_MIB = 50 * 1024 * 1024;
    const HEADER = "Title,Date\n";
    const fd = openSync(csvPath, "w");
    writeSync(fd, HEADER);
    writeSync(fd, "a".repeat(FIFTY_MIB - HEADER.length)); // Exactly 50 MiB total
    closeSync(fd);

    const result = await parseCSVFile(csvPath);
    console.log(`Result: rows=${result.rows.length}, error=${result.error}, malformed=${result.malformedCount}`);
    assert.equal(result.error, undefined, "File at exact limit should parse OK");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile with file 50 MiB + 1 byte", async () => {
  const tmpDir = "/tmp/netflix-test-over-by-one";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "over.csv");

    // Create a file that's 50 MiB + 1 (header "Title,Date\n" is 11 bytes)
    const FIFTY_MIB_PLUS_ONE = 50 * 1024 * 1024 + 1;
    const HEADER = "Title,Date\n";
    const fd = openSync(csvPath, "w");
    writeSync(fd, HEADER);
    writeSync(fd, "a".repeat(FIFTY_MIB_PLUS_ONE - HEADER.length)); // 50 MiB + 1
    closeSync(fd);

    const result = await parseCSVFile(csvPath);
    console.log(`Result: rows=${result.rows.length}, error=${result.error}, malformed=${result.malformedCount}`);
    assert.ok(result.error, "Should error on 50 MiB + 1 file");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
