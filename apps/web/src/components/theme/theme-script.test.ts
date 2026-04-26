/**
 * Guard tests for the inline pre-paint theme resolver.
 *
 * These exist because the App Router-supported "run before first paint"
 * primitive is a raw <script> in <head> of a Server Component, NOT
 * `next/script` with `strategy="beforeInteractive"`. The latter only
 * sequences relative to Next's own scripts and does not block paint,
 * which produced the dark/light/dark flicker users were seeing.
 *
 * If something refactors `theme-script.tsx` to use `next/script` again,
 * these tests should fail. We intentionally read the file as text rather
 * than importing the .tsx module so the test runs under bare
 * `node --test --experimental-strip-types` without a JSX loader.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SCRIPT_FILE = `${HERE}theme-script.tsx`;
const PROVIDER_FILE = `${HERE}theme-provider.tsx`;
const LAYOUT_FILE = `${HERE}../../app/layout.tsx`;

const ADDS_DARK_CLASS = /classList\.add\("dark"\)/;
const REMOVES_DARK_CLASS = /classList\.remove\("dark"\)/;
const READS_PREFERS_DARK = /matchMedia\("\(prefers-color-scheme: dark\)"\)/;
const SETS_COLOR_SCHEME = /style\.colorScheme/;
const READS_THEME_KEY = /pdpp-theme/;
const IIFE_OPENING = /\(function\s*\(\)\s*\{/;
const CATCH_BLOCK = /catch\s*\(_\)/;
const NEXT_SCRIPT_IMPORT = /from\s+["']next\/script["']/;
const DANGEROUSLY_SET = /dangerouslySetInnerHTML/;
const HEAD_BLOCK = /<head>([\s\S]*?)<\/head>/;
const THEME_SCRIPT_TAG = /<ThemeScript\s*\/>/;
const ROOT_PROVIDER_DISABLED = /RootProvider\s+theme=\{\{\s*enabled:\s*false\s*\}\}/;
const PROVIDER_USES_KEY = /THEME_KEY/;
const PROVIDER_SEEDS = /readStoredChoice|readSystemPreference/;

test("resolver applies the dark class and respects stored + system preference", async () => {
  const src = await readFile(SCRIPT_FILE, "utf8");
  // The chain `stored === "light" ? ... : stored === "dark" ? ... : prefersDark`
  // is the contract the theme provider relies on for SSR-safe initial state.
  assert.match(src, ADDS_DARK_CLASS);
  assert.match(src, REMOVES_DARK_CLASS);
  assert.match(src, READS_PREFERS_DARK);
  assert.match(src, SETS_COLOR_SCHEME);
  assert.match(src, READS_THEME_KEY, "resolver reads the pdpp-theme localStorage key");
});

test("resolver is wrapped in IIFE + try/catch so a single failure can never bubble", async () => {
  const src = await readFile(SCRIPT_FILE, "utf8");
  // An uncaught throw in <head> would block paint. Both the outer IIFE
  // body and the storage read have catch-alls.
  assert.match(src, IIFE_OPENING);
  assert.match(src, CATCH_BLOCK);
});

test("ThemeScript renders a raw <script> element, not next/script", async () => {
  // Critical invariant: in App Router, only a raw <script> in <head> of a
  // Server Component runs synchronously before first paint. `next/script`
  // with strategy="beforeInteractive" does not.
  const src = await readFile(SCRIPT_FILE, "utf8");
  assert.equal(NEXT_SCRIPT_IMPORT.test(src), false, "must not import next/script");
  assert.match(src, DANGEROUSLY_SET, "must inject the resolver via dangerouslySetInnerHTML");
});

test("root layout renders <ThemeScript /> inside <head> before <body>", async () => {
  const src = await readFile(LAYOUT_FILE, "utf8");
  // <head>…<ThemeScript />…</head> ordering: the script must appear inside
  // the <head> tag, before the <body> opens.
  const headMatch = src.match(HEAD_BLOCK);
  assert.ok(headMatch, "root layout must include a <head> block");
  assert.match(headMatch?.[1] ?? "", THEME_SCRIPT_TAG);
  // The body must come after </head>.
  const headEnd = src.indexOf("</head>");
  const bodyStart = src.indexOf("<body>");
  assert.ok(headEnd >= 0 && bodyStart > headEnd, "<body> must follow </head>");
});

test("root layout still wraps RootProvider with theme={{ enabled: false }} so Fumadocs does not duplicate the toggle", async () => {
  const src = await readFile(LAYOUT_FILE, "utf8");
  assert.match(src, ROOT_PROVIDER_DISABLED);
});

test("theme-provider seeds React state from the same key the resolver writes", async () => {
  const provider = await readFile(PROVIDER_FILE, "utf8");
  assert.match(provider, PROVIDER_USES_KEY, "provider must read the same storage key as the resolver");
  assert.match(provider, PROVIDER_SEEDS, "provider must seed from storage / system preference");
});
