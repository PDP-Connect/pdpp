// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveSiteRuntime } from "./site-runtime.ts";

const DEV_DIST_DIR = /PDPP_SITE_NEXT_DIST_DIR=\.next-dev/;
const DEV_SOURCE_DIR = /PDPP_SITE_SOURCE_DIR=\.source-dev/;
const VERIFY_DIST_DIR = /PDPP_SITE_NEXT_DIST_DIR=\.next-verify/;
const VERIFY_SOURCE_DIR = /PDPP_SITE_SOURCE_DIR=\.source-verify/;

test("development omits the production worker limit", () => {
  assert.deepEqual(resolveSiteRuntime({ NODE_ENV: "development", PDPP_SITE_NEXT_DIST_DIR: ".next-dev" }), {
    buildWorkers: undefined,
    distDir: ".next-dev",
    isProduction: false,
    sourceDir: ".source",
  });
});

test("production defaults to one worker and accepts an explicit override", () => {
  assert.equal(resolveSiteRuntime({ NODE_ENV: "production" }).buildWorkers, 1);
  assert.equal(resolveSiteRuntime({ NODE_ENV: "production", PDPP_WEB_BUILD_WORKERS: "8" }).buildWorkers, 8);
});

test("supported development and verification commands select distinct output directories", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };

  const { dev, verify } = packageJson.scripts;
  assert.ok(dev);
  assert.ok(verify);
  assert.match(dev, DEV_DIST_DIR);
  assert.match(dev, DEV_SOURCE_DIR);
  assert.match(verify, VERIFY_DIST_DIR);
  assert.match(verify, VERIFY_SOURCE_DIR);
  assert.notEqual(dev, verify);
});
