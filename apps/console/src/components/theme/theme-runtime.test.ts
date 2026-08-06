// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard tests for the theme runtime.
 *
 * The accepted shape is next-themes:
 *   - The shared provider owns browser persistence under `pdpp-theme`.
 *   - Root layouts suppress the expected theme hydration delta.
 *   - Theme state is applied with `data-theme` and follows the system default.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { THEME_KEY } from "./theme-state.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// theme-provider.tsx is a re-export shim; the real implementation lives in
// packages/operator-ui so that both apps share one source of truth.
const PROVIDER_FILE = `${HERE}../../../../../packages/operator-ui/src/components/theme/theme-provider.tsx`;
const LAYOUT_FILE = `${HERE}../../app/layout.tsx`;
const BRAND_PRIMITIVE_FILE = `${HERE}../../../../../packages/pdpp-brand/tokens/primitive.css`;
const BRAND_INDEX_FILE = `${HERE}../../../../../packages/pdpp-brand/index.css`;
const STATUS_BADGE_CSS_FILE = `${HERE}../../../../../packages/operator-ui/src/components/status-badge.css`;

const NEXT_THEMES_IMPORT = /from "next-themes"/;
const NEXT_THEMES_PROVIDER = /ThemeProvider as NextThemesProvider/;
const ATTRIBUTE = /attribute="data-theme"/;
const DEFAULT_THEME = /defaultTheme="system"/;
const DISABLE_TRANSITIONS = /disableTransitionOnChange/;
const DISABLE_COLOR_SCHEME = /enableColorScheme=\{false\}/;
const ENABLE_SYSTEM = /enableSystem/;
const STORAGE_KEY = /storageKey="pdpp-theme"/;
const ROOT_PROVIDER = /<ThemeProvider>/;
const SUPPRESS_HYDRATION = /suppressHydrationWarning/;
const THEME_COOKIE_IMPORT = /components\/theme\/theme-state/;
const THEME_FOUC_GUARD = /launchFoucGuardCss|dangerouslySetInnerHTML/;
const DATA_THEME_DARK_VARIANT = /@custom-variant\s+dark\s*\([\s\S]*\[data-theme="dark"\]/;
const STATUS_BADGE_FOREGROUND_TOKENS =
  /--success-badge-foreground:[\s\S]*--warning-badge-foreground:[\s\S]*--danger-badge-foreground:/;
const STATUS_BADGE_RING_TOKENS =
  /--status-success-ring:[\s\S]*--status-warning-ring:[\s\S]*--status-danger-ring:[\s\S]*--status-neutral-ring:/;
const STATUS_BADGE_TONE_CLASSES =
  /\.pdpp-status-badge\s*{[\s\S]*color: var\(--status-badge-fg\);[\s\S]*background-color: var\(--status-badge-bg\);[\s\S]*box-shadow: inset 0 0 0 1px var\(--status-badge-ring\);[\s\S]*\.pdpp-status-success\s*{[\s\S]*--status-badge-fg: var\(--status-success-fg\);[\s\S]*\.pdpp-status-danger\s*{[\s\S]*--status-badge-fg: var\(--status-danger-fg\);[\s\S]*\.pdpp-status-warning\s*{[\s\S]*--status-badge-fg: var\(--status-warning-fg\);[\s\S]*\.pdpp-status-neutral\s*{[\s\S]*--status-badge-fg: var\(--status-neutral-fg\);/;

test("theme storage key stays stable", () => {
  assert.equal(THEME_KEY, "pdpp-theme");
});

test("root layout delegates theme state to next-themes", async () => {
  const src = await readFile(LAYOUT_FILE, "utf8");
  assert.match(src, ROOT_PROVIDER);
  assert.match(src, SUPPRESS_HYDRATION);
  assert.equal(THEME_COOKIE_IMPORT.test(src), false, "root layout must not read a theme cookie");
  assert.equal(THEME_FOUC_GUARD.test(src), false, "root layout must not own a theme FOUC guard");
});

test("shared provider configures the required next-themes runtime", async () => {
  const src = await readFile(PROVIDER_FILE, "utf8");
  assert.match(src, NEXT_THEMES_IMPORT);
  assert.match(src, NEXT_THEMES_PROVIDER);
  assert.match(src, ATTRIBUTE);
  assert.match(src, DEFAULT_THEME);
  assert.match(src, DISABLE_TRANSITIONS);
  assert.equal(DISABLE_COLOR_SCHEME.test(src), false, "provider must let next-themes manage color-scheme");
  assert.match(src, ENABLE_SYSTEM);
  assert.match(src, STORAGE_KEY);
});

test("status badge tones bind status surface tokens via co-located CSS", async () => {
  const semantic = await readFile(BRAND_PRIMITIVE_FILE, "utf8");
  const statusBadge = await readFile(STATUS_BADGE_CSS_FILE, "utf8");
  assert.match(semantic, STATUS_BADGE_FOREGROUND_TOKENS);
  assert.match(semantic, STATUS_BADGE_RING_TOKENS);
  assert.match(statusBadge, STATUS_BADGE_TONE_CLASSES);
});

test("Tailwind dark variant follows the next-themes data attribute", async () => {
  const src = await readFile(BRAND_INDEX_FILE, "utf8");
  assert.match(src, DATA_THEME_DARK_VARIANT);
});
