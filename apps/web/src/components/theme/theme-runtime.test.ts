/**
 * Guard tests for the theme runtime.
 *
 * The accepted shape is CSS driven: no inline script, no
 * suppressHydrationWarning, system mode uses `prefers-color-scheme` CSS for
 * first paint, and explicit choices persist in localStorage.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeThemeChoice, THEME_KEY } from "./theme-state.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PROVIDER_FILE = `${HERE}theme-provider.tsx`;
const LAYOUT_FILE = `${HERE}../../app/layout.tsx`;
const GLOBALS_FILE = `${HERE}../../app/globals.css`;
const BRAND_BASE_FILE = `${HERE}../../../../../packages/pdpp-brand/base.css`;

const DANGEROUSLY_SET = /dangerouslySetInnerHTML/;
const INLINE_THEME_SCRIPT = /<script|next\/script|ThemeScript|pdpp-theme-init/;
const SUPPRESS_HYDRATION = /suppressHydrationWarning/;
const COOKIES_IMPORT = /from\s+["']next\/headers["']/;
const HTML_SYSTEM_THEME = /<html data-theme="system" lang="en">/;
const ROOT_PROVIDER = /<ThemeProvider>/;
const LOCAL_STORAGE_SET = /window\.localStorage\.setItem\(THEME_KEY, next\)/;
const LOCAL_STORAGE_REMOVE = /window\.localStorage\.removeItem\(THEME_KEY\)/;
const LOCAL_STORAGE_READ = /window\.localStorage\.getItem\(THEME_KEY\)/;
const DOCUMENT_COOKIE = /document\.cookie|cookieStore|next\/headers/;
const SYSTEM_MEDIA = /@media \(prefers-color-scheme: dark\)[\s\S]*html\[data-theme="system"\]/;
const EXPLICIT_DARK_SELECTOR = /html\[data-theme="dark"\]/;
const DATA_THEME_DARK_VARIANT =
  /@custom-variant dark \(&:where\(\.dark, \.dark \*, \[data-theme=dark\], \[data-theme=dark\] \*\)\)/;

test("theme choice normalization accepts only the supported vocabulary", () => {
  assert.equal(THEME_KEY, "pdpp-theme");
  assert.equal(normalizeThemeChoice("light"), "light");
  assert.equal(normalizeThemeChoice("dark"), "dark");
  assert.equal(normalizeThemeChoice("system"), "system");
  assert.equal(normalizeThemeChoice(""), "system");
  assert.equal(normalizeThemeChoice("midnight"), "system");
});

test("root layout renders system theme without scripts, cookies, or hydration suppression", async () => {
  const src = await readFile(LAYOUT_FILE, "utf8");
  assert.equal(COOKIES_IMPORT.test(src), false, "root layout must remain static and not read cookies");
  assert.match(src, HTML_SYSTEM_THEME);
  assert.match(src, ROOT_PROVIDER);
  assert.equal(INLINE_THEME_SCRIPT.test(src), false, "root layout must not render theme scripts");
  assert.equal(SUPPRESS_HYDRATION.test(src), false, "theme runtime must not rely on hydration-warning suppression");
});

test("theme provider persists explicit choices locally without cookie mutation", async () => {
  const src = await readFile(PROVIDER_FILE, "utf8");
  assert.match(src, LOCAL_STORAGE_READ);
  assert.match(src, LOCAL_STORAGE_SET);
  assert.match(src, LOCAL_STORAGE_REMOVE);
  assert.equal(DOCUMENT_COOKIE.test(src), false, "client theme runtime must not mutate cookies directly");
  assert.equal(DANGEROUSLY_SET.test(src), false);
});

test("brand CSS supports explicit dark and first-paint system dark without JavaScript", async () => {
  const src = await readFile(BRAND_BASE_FILE, "utf8");
  assert.match(src, EXPLICIT_DARK_SELECTOR);
  assert.match(src, SYSTEM_MEDIA);
});

test("Tailwind dark variant follows explicit dark theme attributes", async () => {
  const src = await readFile(GLOBALS_FILE, "utf8");
  assert.match(src, DATA_THEME_DARK_VARIANT);
});
