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
const VERIFY_TSCONFIG = /PDPP_SITE_TSCONFIG=tsconfig\.verify\.json/;

test("development omits the production worker limit", () => {
  assert.deepEqual(resolveSiteRuntime({ NODE_ENV: "development", PDPP_SITE_NEXT_DIST_DIR: ".next-dev" }), {
    buildWorkers: undefined,
    distDir: ".next-dev",
    isProduction: false,
    sourceDir: ".source",
    tsconfigPath: "tsconfig.json",
  });
});

test("production defaults to one worker and accepts an explicit override", () => {
  assert.equal(resolveSiteRuntime({ NODE_ENV: "production" }).buildWorkers, 1);
  assert.equal(resolveSiteRuntime({ NODE_ENV: "production", PDPP_WEB_BUILD_WORKERS: "8" }).buildWorkers, 8);
});

// The default sourceDir/tsconfigPath pairing must stay consistent: a mode
// that does not set PDPP_SITE_SOURCE_DIR resolves "@generated-docs/*" via
// tsconfig.json's own ".source" paths entry, so a plain resolveSiteRuntime()
// call must also default to that same tsconfig, not verify's.
test("default source directory pairs with the base tsconfig, not a per-mode override", () => {
  const runtime = resolveSiteRuntime({});
  assert.equal(runtime.sourceDir, ".source");
  assert.equal(runtime.tsconfigPath, "tsconfig.json");
});

test("PDPP_SITE_TSCONFIG overrides the default tsconfig path", () => {
  assert.equal(resolveSiteRuntime({ PDPP_SITE_TSCONFIG: "tsconfig.verify.json" }).tsconfigPath, "tsconfig.verify.json");
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

// verify's own tsc pass (types:check) and next build's internal type-check
// must resolve "@generated-docs/*" against .source-verify, not the base
// tsconfig's ".source" — see tsconfig.verify.json and next.config.mjs's
// typescript.tsconfigPath wiring. A stale .source left by an unrelated
// dev/build run must never be able to mask a type error in verify's own
// freshly generated output.
test("verify selects its own tsconfig, distinct from the base config", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };

  const { verify } = packageJson.scripts;
  assert.ok(verify);
  assert.match(verify, VERIFY_TSCONFIG);
});
