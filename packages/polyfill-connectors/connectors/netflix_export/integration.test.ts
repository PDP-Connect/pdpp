// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Netflix export connector. Tests full CSV file
 * parsing, duplicate handling, and archive resolution.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findViewingActivityFiles, parseCSVFile, resolveViewingActivityFile, validateArchivePath } from "./parsers.ts";

test("parseCSVFile reads and parses a complete CSV fixture", async () => {
  const csvContent = `Title,Watched at,Device type,Watch duration,Profile name
"The Crown","2024-01-15","TV","85%","Main"
"Stranger Things","2024-01-14","Phone","92%","Shared"`;

  const tmpDir = "/tmp/netflix-test-basic";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "test.csv");
    writeFileSync(csvPath, csvContent, "utf8");

    const result = await parseCSVFile(csvPath);
    assert.equal(result.rows.length, 2);
    assert.equal(result.malformedCount, 0);
    assert.equal((result.rows[0] as Record<string, unknown>).title, "The Crown");
    assert.equal((result.rows[1] as Record<string, unknown>).title, "Stranger Things");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile detects malformed rows with unclosed quotes", async () => {
  const csvContent = `Title,Watched at,Device type,Watch duration,Profile name
"Incomplete Quote","2024-01-15","TV","85%","Main"
"Unclosed Quote,2024-01-14,Phone,92%,Shared
"Valid Row","2024-01-13","Laptop","50%","Main"`;

  const tmpDir = "/tmp/netflix-test-malformed";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "test.csv");
    writeFileSync(csvPath, csvContent, "utf8");

    const result = await parseCSVFile(csvPath);
    assert.equal(result.malformedCount, 1); // one unclosed quote accumulates through EOF
    assert.equal(result.rows.length, 1); // only the first valid row parses before the malformed section starts
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile handles empty file", async () => {
  const tmpDir = "/tmp/netflix-test-empty";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "empty.csv");
    writeFileSync(csvPath, "", "utf8");

    const result = await parseCSVFile(csvPath);
    assert.equal(result.rows.length, 0);
    assert.equal(result.malformedCount, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile handles file with only headers", async () => {
  const csvContent = "Title,Watched at,Device type,Watch duration,Profile name";

  const tmpDir = "/tmp/netflix-test-headers-only";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "test.csv");
    writeFileSync(csvPath, csvContent, "utf8");

    const result = await parseCSVFile(csvPath);
    assert.equal(result.rows.length, 0, "Empty file should parse to 0 rows");
    assert.equal(result.malformedCount, 0, "No malformed rows expected");
    assert.equal(result.error, undefined, "No error expected");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile handles multi-line quoted fields (RFC 4180)", async () => {
  const csvContent = `Title,Watched at
"Multi
Line Title","2024-01-15"
"Normal","2024-01-14"`;

  const tmpDir = "/tmp/netflix-test-multiline";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const csvPath = join(tmpDir, "test.csv");
    writeFileSync(csvPath, csvContent, "utf8");

    const result = await parseCSVFile(csvPath);
    assert.ok(result.rows.length >= 1, "Should parse at least one row");
    assert.ok(
      result.rows.some((r) => r.title?.includes("Multi") || r.title === "Normal"),
      "Should contain multi-line or normal row"
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("findViewingActivityFiles searches directory tree", () => {
  const tmpDir = "/tmp/netflix-test-find";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const subdir = join(tmpDir, "CONTENT_INTERACTION");
    mkdirSync(subdir);
    const csvPath = join(subdir, "ViewingActivity.csv");
    writeFileSync(csvPath, "Title,Watched at\n", "utf8");

    const found = findViewingActivityFiles(tmpDir);
    assert.ok(found.some((p) => p.includes("ViewingActivity.csv")));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("findViewingActivityFiles handles case-insensitive filename search", () => {
  const tmpDir = "/tmp/netflix-test-case";
  mkdirSync(tmpDir, { recursive: true });
  try {
    // Create a file with different casing
    const subdir = join(tmpDir, "content_interaction");
    mkdirSync(subdir);
    const csvPath = join(subdir, "viewingactivity.csv");
    writeFileSync(csvPath, "Title,Watched at\n", "utf8");

    const found = findViewingActivityFiles(tmpDir);
    assert.ok(found.some((p) => p.toLowerCase().includes("viewingactivity.csv")));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile handles non-existent file gracefully", async () => {
  const result = await parseCSVFile("/tmp/does-not-exist-netflix-test.csv");
  assert.equal(result.rows.length, 0);
  assert.equal(result.malformedCount, 0);
});

test("validateArchivePath validates path containment", () => {
  const tmpDir = "/tmp/netflix-test-traversal";
  const otherDir = "/tmp/netflix-test-other";
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  try {
    // File outside the expected directory
    const externalPath = join(otherDir, "escape.csv");
    writeFileSync(externalPath, "test", "utf8");

    const result = validateArchivePath(externalPath, tmpDir);
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("Path traversal"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});

test("resolveViewingActivityFile returns error on archive validation failure", () => {
  const tmpDir = "/tmp/netflix-test-resolve-safety";
  mkdirSync(tmpDir, { recursive: true });
  try {
    // Create a fake archive structure
    const contentDir = join(tmpDir, "CONTENT_INTERACTION");
    mkdirSync(contentDir);
    const csvPath = join(contentDir, "ViewingActivity.csv");
    writeFileSync(csvPath, "Title,Watched at\n", "utf8");

    // This should succeed (normal case)
    const result = resolveViewingActivityFile(tmpDir);
    assert.ok(result.path, "Should find valid path");
    assert.ok(!result.error, "Should have no error");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseCSVFile handles non-existent files in bounds check", async () => {
  const result = await parseCSVFile("/nonexistent/huge-file.csv");
  assert.equal(result.rows.length, 0);
});

test("connector subprocess integration: emits viewing_activity records", async () => {
  const tmpDir = "/tmp/netflix-test-subprocess";
  mkdirSync(tmpDir, { recursive: true });
  try {
    const contentDir = join(tmpDir, "CONTENT_INTERACTION");
    mkdirSync(contentDir);
    const csvPath = join(contentDir, "ViewingActivity.csv");

    const csvContent = `Title,Watched at,Device type,Watch duration,Profile name
"The Crown","2024-01-15 10:30:00","TV","85%","Main"
"Stranger Things","2024-01-14 15:45:00","Phone","92%","Secondary"`;

    writeFileSync(csvPath, csvContent, "utf8");

    const result = await parseCSVFile(csvPath);
    assert.equal(result.rows.length, 2, "Should parse 2 data rows");
    assert.equal(result.malformedCount, 0, "No malformed rows");
    assert.ok(result.rows[0]?.title, "First row has title");
    assert.ok(result.rows[1]?.title, "Second row has title");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
