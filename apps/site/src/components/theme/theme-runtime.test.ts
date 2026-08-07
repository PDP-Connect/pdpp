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
const SITE_PROVIDERS_FILE = `${HERE}../site/site-providers.tsx`;
const BRAND_PRIMITIVE_FILE = `${HERE}../../../../../packages/pdpp-brand/styles/tokens/primitive.css`;
const BRAND_SEMANTIC_FILE = `${HERE}../../../../../packages/pdpp-brand/styles/tokens/semantic.css`;
const BRAND_INDEX_FILE = `${HERE}../../../../../packages/pdpp-brand/styles/index.css`;
const BRAND_TAILWIND_ALIASES_FILE = `${HERE}../../../../../packages/pdpp-brand/styles/tokens/tailwind-aliases.css`;
const BRAND_TYPOGRAPHY_FILE = `${HERE}../../../../../packages/pdpp-brand/styles/typography.css`;
const BRAND_REACT_COMPONENTS_FILE = `${HERE}../../../../../packages/pdpp-brand-react/src/components.css`;
const STATUS_BADGE_CSS_FILE = `${HERE}../../../../../packages/operator-ui/src/components/status-badge.css`;

const NEXT_THEMES_IMPORT = /from "next-themes"/;
const NEXT_THEMES_PROVIDER = /ThemeProvider as NextThemesProvider/;
const ATTRIBUTE = /attribute="data-theme"/;
const DEFAULT_THEME = /defaultTheme="system"/;
const DISABLE_TRANSITIONS = /disableTransitionOnChange/;
const DISABLE_COLOR_SCHEME = /enableColorScheme=\{false\}/;
const ENABLE_SYSTEM = /enableSystem/;
const STORAGE_KEY = /storageKey="pdpp-theme"/;
const ROOT_PROVIDER = /<SiteProviders>/;
const SITE_THEME_PROVIDER = /<ThemeProvider>/;
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
const SEMANTIC_TYPE_SCALE =
  /@theme\s*{[\s\S]*--text-small:\s*12px;[\s\S]*--text-body:\s*14px;[\s\S]*--text-heading:\s*20px;[\s\S]*--text-hero:\s*60px;/;
const TYPE_SCALE_DECLARATION = /--text-(?:eyebrow|small|body|lede|heading|title|display|hero):/;
const TAILWIND_COLOR_DECLARATION = /^\s*--color-[\w-]+:/m;
const LITERAL_COMPATIBILITY_FONT_SIZE = /font-size:\s*[\d.]+(?:px|rem)/;
const DUPLICATE_COMPATIBILITY_SELECTOR =
  /^\.pdpp-(?:display-lg|display|heading|title|body-lg|body|label|caption|eyebrow)\s*{/m;
const TAILWIND_TEXT_ALIAS_TARGETS = {
  xs: "small",
  sm: "body",
  base: "body",
  lg: "lede",
  xl: "heading",
  "2xl": "heading",
  "3xl": "heading",
  "4xl": "display",
  "5xl": "display",
  "6xl": "hero",
  "7xl": "hero",
  "8xl": "hero",
  "9xl": "hero",
} as const;
const STATIC_RADIUS_ALIASES = {
  rounded: "radius-sm",
  "rounded-full": "radius-pill",
} as const;

test("theme storage key stays stable", () => {
  assert.equal(THEME_KEY, "pdpp-theme");
});

test("root layout delegates theme state to site providers", async () => {
  const [layout, providers] = await Promise.all([readFile(LAYOUT_FILE, "utf8"), readFile(SITE_PROVIDERS_FILE, "utf8")]);
  assert.match(layout, ROOT_PROVIDER);
  assert.match(layout, SUPPRESS_HYDRATION);
  assert.match(providers, SITE_THEME_PROVIDER);
  assert.equal(THEME_COOKIE_IMPORT.test(layout), false, "root layout must not read a theme cookie");
  assert.equal(THEME_FOUC_GUARD.test(layout), false, "root layout must not own a theme FOUC guard");
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

test("semantic tokens exclusively own the shared type scale", async () => {
  const [semantic, aliases, typography, brandReact] = await Promise.all([
    readFile(BRAND_SEMANTIC_FILE, "utf8"),
    readFile(BRAND_TAILWIND_ALIASES_FILE, "utf8"),
    readFile(BRAND_TYPOGRAPHY_FILE, "utf8"),
    readFile(BRAND_REACT_COMPONENTS_FILE, "utf8"),
  ]);

  assert.match(semantic, SEMANTIC_TYPE_SCALE);
  assert.equal(TYPE_SCALE_DECLARATION.test(aliases), false, "Tailwind aliases must not own semantic type values");
  assert.equal(LITERAL_COMPATIBILITY_FONT_SIZE.test(typography), false, "legacy classes must consume semantic tokens");
  assert.equal(
    DUPLICATE_COMPATIBILITY_SELECTOR.test(brandReact),
    false,
    "brand-react must not redefine shared type classes"
  );
});

test("Tailwind default text utilities resolve through the PDPP type scale", async () => {
  const aliases = await readFile(BRAND_TAILWIND_ALIASES_FILE, "utf8");

  for (const [tailwindStep, semanticStep] of Object.entries(TAILWIND_TEXT_ALIAS_TARGETS)) {
    assert.match(aliases, new RegExp(`--text-${tailwindStep}:\\s*var\\(--text-${semanticStep}\\);`));
    assert.match(
      aliases,
      new RegExp(`--text-${tailwindStep}--line-height:\\s*var\\(--text-${semanticStep}--line-height\\);`)
    );
    assert.match(
      aliases,
      new RegExp(`--text-${tailwindStep}--letter-spacing:\\s*var\\(--text-${semanticStep}--letter-spacing\\);`)
    );
    assert.match(
      aliases,
      new RegExp(`--text-${tailwindStep}--font-weight:\\s*var\\(--text-${semanticStep}--font-weight\\);`)
    );
  }
});

test("Tailwind static radius utilities resolve through PDPP radius tokens", async () => {
  const aliases = await readFile(BRAND_TAILWIND_ALIASES_FILE, "utf8");

  for (const [utility, token] of Object.entries(STATIC_RADIUS_ALIASES)) {
    assert.match(aliases, new RegExp(`\\.${utility}\\s*{\\s*border-radius:\\s*var\\(--${token}\\);\\s*}`));
  }
});

test("semantic tokens own PDPP Tailwind color registrations", async () => {
  const [semantic, aliases] = await Promise.all([
    readFile(BRAND_SEMANTIC_FILE, "utf8"),
    readFile(BRAND_TAILWIND_ALIASES_FILE, "utf8"),
  ]);
  assert.match(semantic, TAILWIND_COLOR_DECLARATION);
  assert.equal(
    TAILWIND_COLOR_DECLARATION.test(aliases),
    false,
    "tailwind-aliases.css must contain only Tailwind default-name remaps"
  );
});
