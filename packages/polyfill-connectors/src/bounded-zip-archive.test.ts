// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { hasZipLocalFileSignature, readZipEntries, zipBasename } from "./bounded-zip-archive.ts";

function buildZip(files: { name: string; content: string }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const contentBuf = Buffer.from(file.content, "utf8");
    const compressed = deflateRawSync(contentBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04_03_4b_50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x08_00, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(contentBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x08_00, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(contentBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(Buffer.concat([centralHeader, nameBuf]));
    offset += localEntry.length;
  }

  const centralDirStart = offset;
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(centralDirStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

test("readZipEntries reads a flat single-entry zip", () => {
  const zip = buildZip([{ name: "hello.txt", content: "hello world" }]);
  const entries = readZipEntries(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.name, "hello.txt");
  assert.equal(entries[0]?.data().toString("utf8"), "hello world");
});

test("readZipEntries reads nested-path entries", () => {
  const zip = buildZip([
    { name: "CONTENT_INTERACTION/ViewingActivity.csv", content: "Title,Watched at\nFoo,2024-01-01\n" },
    { name: "OTHER/ignored.csv", content: "irrelevant" },
  ]);
  const entries = readZipEntries(zip);
  assert.equal(entries.length, 2);
  const match = entries.find((e) => e.name.endsWith("ViewingActivity.csv"));
  assert.ok(match);
  assert.match(match?.data().toString("utf8") ?? "", /Foo,2024-01-01/);
});

test("readZipEntries returns empty list for non-zip input", () => {
  const entries = readZipEntries(Buffer.from("not a zip file at all"));
  assert.deepEqual(entries, []);
});

test("hasZipLocalFileSignature detects zip magic bytes", () => {
  const zip = buildZip([{ name: "a.txt", content: "x" }]);
  assert.equal(hasZipLocalFileSignature(zip), true);
  assert.equal(hasZipLocalFileSignature(Buffer.from("plain text")), false);
});

test("zipBasename strips directory components", () => {
  assert.equal(zipBasename("CONTENT_INTERACTION/ViewingActivity.csv"), "ViewingActivity.csv");
  assert.equal(zipBasename("plain.csv"), "plain.csv");
  assert.equal(zipBasename("a\\b\\c.csv"), "c.csv");
});
