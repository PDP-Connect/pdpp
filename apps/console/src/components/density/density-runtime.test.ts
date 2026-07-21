// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildDensityCookie, DENSITY_KEY, normalizeDensity } from "./density-state.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PROVIDER_FILE = `${HERE}density-provider.tsx`;
const LAYOUT_FILE = `${HERE}../../app/layout.tsx`;
const BRAND_BASE_FILE = `${HERE}../../../../../packages/pdpp-brand/base.css`;

const NEXT_HEADERS_IMPORT_RE = /from "next\/headers"/;
const LAYOUT_NORMALIZES_DENSITY_RE = /normalizeDensity\(cookieStore\.get\(DENSITY_KEY\)\?\.value\)/;
const HTML_DATA_DENSITY_RE = /data-density=\{density\}/;
const DENSITY_PROVIDER_RE = /<DensityProvider initialDensity=\{density\}>/;
const SUPPRESS_HYDRATION_RE = /suppressHydrationWarning/;
const DOCUMENT_COOKIE_RE = /document\.cookie/;
const DOCUMENT_DATASET_RE = /document\.documentElement\.dataset\.density = density/;
const BUILD_COOKIE_RE = /buildDensityCookie\(next, secure\)/;
const LOCAL_STORAGE_RE = /localStorage/;
const ROW_PY_DEFAULT_RE = /--data-list-row-py:\s*0\.5rem/;
const ROW_PY_COMPACT_RE = /html\[data-density="compact"\]\s*\{[\s\S]*--data-list-row-py:\s*0\.3125rem/;
const ROW_CLASS_RE = /\.pdpp-data-list-row\s*\{[\s\S]*padding-block:\s*var\(--data-list-row-py\)/;

test("density normalization accepts compact and defaults to comfortable", () => {
  assert.equal(DENSITY_KEY, "pdpp-density");
  assert.equal(normalizeDensity("compact"), "compact");
  assert.equal(normalizeDensity("comfortable"), "comfortable");
  assert.equal(normalizeDensity("dense"), "comfortable");
  assert.equal(normalizeDensity(undefined), "comfortable");
});

test("buildDensityCookie persists compact and clears comfortable", () => {
  assert.equal(buildDensityCookie("compact", false), "pdpp-density=compact; Path=/; SameSite=Lax; Max-Age=31536000");
  assert.equal(
    buildDensityCookie("compact", true),
    "pdpp-density=compact; Path=/; SameSite=Lax; Max-Age=31536000; Secure"
  );
  assert.equal(buildDensityCookie("comfortable", false), "pdpp-density=; Path=/; SameSite=Lax; Max-Age=0");
  assert.equal(buildDensityCookie("comfortable", true), "pdpp-density=; Path=/; SameSite=Lax; Max-Age=0; Secure");
});

test("root layout renders density from the cookie on html and seeds the provider", async () => {
  const src = await readFile(LAYOUT_FILE, "utf8");

  assert.match(src, NEXT_HEADERS_IMPORT_RE);
  assert.match(src, LAYOUT_NORMALIZES_DENSITY_RE);
  assert.match(src, HTML_DATA_DENSITY_RE);
  assert.match(src, DENSITY_PROVIDER_RE);
  assert.equal(SUPPRESS_HYDRATION_RE.test(src), false);
});

test("density provider uses cookies as the only persisted source of truth", async () => {
  const src = await readFile(PROVIDER_FILE, "utf8");

  assert.match(src, DOCUMENT_COOKIE_RE);
  assert.match(src, DOCUMENT_DATASET_RE);
  assert.match(src, BUILD_COOKIE_RE);
  assert.equal(LOCAL_STORAGE_RE.test(src), false);
});

test("brand CSS exposes a density row token and compact html override", async () => {
  const src = await readFile(BRAND_BASE_FILE, "utf8");

  assert.match(src, ROW_PY_DEFAULT_RE);
  assert.match(src, ROW_PY_COMPACT_RE);
  assert.match(src, ROW_CLASS_RE);
});
