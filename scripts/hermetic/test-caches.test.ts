// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hermeticTestEnvironment } from "./launcher.ts";
import { compileCacheDirectory, linkTransformCache, pruneCompileCache } from "./test-caches.ts";

const CHECKOUT_COMPILE_CACHE = /node_modules\/\.cache\/pdpp-test\/node-compile$/;

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "pdpp-test-caches-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the launcher points Node's compile cache at the checkout and keeps a caller's choice", () => {
  const defaulted = hermeticTestEnvironment({});
  assert.equal(defaulted.NODE_COMPILE_CACHE, compileCacheDirectory());
  assert.match(defaulted.NODE_COMPILE_CACHE ?? "", CHECKOUT_COMPILE_CACHE);
  assert.equal(hermeticTestEnvironment({ NODE_COMPILE_CACHE: "/elsewhere" }).NODE_COMPILE_CACHE, "/elsewhere");
});

test("a scratch root gets one link to the persistent tsx cache, and linking twice is harmless", () => {
  withTemporaryDirectory((directory) => {
    const scratch = join(directory, "scratch");
    const cacheRoot = join(directory, "cache");
    mkdirSync(scratch);
    linkTransformCache(scratch, cacheRoot);
    linkTransformCache(scratch, cacheRoot);
    const links = readdirSync(scratch).filter((name) => name.startsWith("tsx-"));
    assert.equal(links.length, 1);
    const link = join(scratch, links[0] as string);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), join(cacheRoot, "tsx"));
    rmSync(scratch, { recursive: true });
    assert.ok(existsSync(join(cacheRoot, "tsx")), "removing a scratch root must not remove the cache");
  });
});

test("pruning removes compile-cache entries older than two weeks and keeps newer ones", () => {
  withTemporaryDirectory((directory) => {
    const generation = join(compileCacheDirectory(directory), "v0-x64-test");
    mkdirSync(generation, { recursive: true });
    const now = Date.now();
    for (const [name, ageDays] of [
      ["stale", 15],
      ["fresh", 13],
    ] as const) {
      writeFileSync(join(generation, name), "");
      const time = new Date(now - ageDays * 24 * 60 * 60 * 1000);
      utimesSync(join(generation, name), time, time);
    }
    pruneCompileCache(now, directory);
    assert.deepEqual(readdirSync(generation), ["fresh"]);
    pruneCompileCache(now, join(directory, "absent"));
  });
});

// Seeded fault: a cache that served stale code would keep printing the old value
// after the file changed. Both caches are warm when the file is edited.
test("an edited module is rebuilt even when both caches are warm", () => {
  withTemporaryDirectory((directory) => {
    const scratch = join(directory, "scratch");
    const cacheRoot = join(directory, "cache");
    const module = join(directory, "value.ts");
    mkdirSync(scratch);
    linkTransformCache(scratch, cacheRoot);
    const run = () => {
      const env = { ...process.env, TMPDIR: scratch, NODE_COMPILE_CACHE: compileCacheDirectory(cacheRoot) };
      // An operator who disabled a cache to compare costs must not break this test.
      env.TSX_DISABLE_CACHE = undefined;
      env.NODE_DISABLE_COMPILE_CACHE = undefined;
      return execFileSync(process.execPath, ["--import", "tsx", module], {
        cwd: process.cwd(),
        encoding: "utf8",
        env,
      }).trim();
    };
    const write = (value: number) => writeFileSync(module, `const value: number = ${value};\nconsole.log(value);\n`);
    write(1);
    assert.equal(run(), "1");
    assert.ok(readdirSync(join(cacheRoot, "tsx")).length > 0, "the first run should have filled the tsx cache");
    assert.equal(run(), "1");
    write(2);
    assert.equal(run(), "2");
  });
});
