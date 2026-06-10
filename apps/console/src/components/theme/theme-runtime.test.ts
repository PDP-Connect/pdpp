/**
 * Guard tests for the theme runtime.
 *
 * The accepted shape is cookie-backed SSR:
 *   - Server reads the `pdpp-theme` cookie via `cookies()` from `next/headers`
 *     and renders `<html data-theme=...>` (with `dark` class for explicit
 *     dark) — no inline script, no hydration suppression, no flicker.
 *   - Client persists the user's choice to the same cookie. localStorage is
 *     intentionally NOT used so there's a single source of truth.
 *   - "system" mode resolves to the OS preference at first paint via the
 *     `@media (prefers-color-scheme: dark)` rules in the brand CSS.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildThemeCookie, normalizeThemeChoice, THEME_KEY } from "./theme-state.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PROVIDER_FILE = `${HERE}theme-provider.tsx`;
const LAYOUT_FILE = `${HERE}../../app/layout.tsx`;
const GLOBALS_FILE = `${HERE}../../app/globals.css`;
const BRAND_BASE_FILE = `${HERE}../../../../../packages/pdpp-brand/base.css`;

const DANGEROUSLY_SET = /dangerouslySetInnerHTML/;
const INLINE_THEME_SCRIPT = /<script|next\/script|ThemeScript|pdpp-theme-init/;
const SUPPRESS_HYDRATION = /suppressHydrationWarning/;
const COOKIES_IMPORT = /from\s+["']next\/headers["']/;
const COOKIES_CALL = /await\s+cookies\(\)/;
const HTML_DATA_THEME_DYNAMIC = /<html[^>]*data-theme=\{choice\}/;
const ROOT_PROVIDER = /<ThemeProvider>/;
const COOKIE_READ = /document\.cookie/;
const COOKIE_WRITE = /document\.cookie\s*=\s*buildThemeCookie\(/;
const NO_LOCAL_STORAGE = /window\.localStorage/;
const SYSTEM_MEDIA = /@media \(prefers-color-scheme: dark\)[\s\S]*html\[data-theme="system"\]/;
const EXPLICIT_DARK_SELECTOR = /html\[data-theme="dark"\]/;
const DATA_THEME_DARK_VARIANT =
  /@custom-variant dark \(&:where\(\.dark, \.dark \*, \[data-theme=dark\], \[data-theme=dark\] \*\)\)/;
const STATUS_BADGE_FOREGROUND_TOKENS =
  /--success-badge-foreground:[\s\S]*--warning-badge-foreground:[\s\S]*--danger-badge-foreground:/;
const STATUS_BADGE_SEMANTIC_COLOR_RULES =
  /\.pdpp-status-badge\[data-status-tone="success"\]\s*{\s*color: var\(--success-badge-foreground\);[\s\S]*\.pdpp-status-badge\[data-status-tone="danger"\]\s*{\s*color: var\(--danger-badge-foreground\);[\s\S]*\.pdpp-status-badge\[data-status-tone="warning"\]\s*{\s*color: var\(--warning-badge-foreground\);/;
const COOKIE_SYSTEM_NO_SECURE = /^pdpp-theme=; Path=\/; SameSite=Lax; Max-Age=0$/;
const COOKIE_SYSTEM_SECURE = /^pdpp-theme=; Path=\/; SameSite=Lax; Max-Age=0; Secure$/;
const COOKIE_LIGHT_NO_SECURE = /^pdpp-theme=light; Path=\/; SameSite=Lax; Max-Age=31536000$/;
const COOKIE_DARK_SECURE = /^pdpp-theme=dark; Path=\/; SameSite=Lax; Max-Age=31536000; Secure$/;

test("theme choice normalization accepts only the supported vocabulary", () => {
  assert.equal(THEME_KEY, "pdpp-theme");
  assert.equal(normalizeThemeChoice("light"), "light");
  assert.equal(normalizeThemeChoice("dark"), "dark");
  assert.equal(normalizeThemeChoice("system"), "system");
  assert.equal(normalizeThemeChoice(""), "system");
  assert.equal(normalizeThemeChoice("midnight"), "system");
  assert.equal(normalizeThemeChoice(undefined), "system");
});

test("buildThemeCookie emits a clearing cookie for system and a long-lived cookie for explicit choices", () => {
  // System reverts to default — express that as cookie removal.
  assert.match(buildThemeCookie("system", false), COOKIE_SYSTEM_NO_SECURE);
  assert.match(buildThemeCookie("system", true), COOKIE_SYSTEM_SECURE);

  // Explicit choices persist for a year. Secure attribute follows the env.
  assert.match(buildThemeCookie("light", false), COOKIE_LIGHT_NO_SECURE);
  assert.match(buildThemeCookie("dark", true), COOKIE_DARK_SECURE);
});

test("root layout reads the theme cookie server-side and renders without scripts or hydration suppression", async () => {
  const src = await readFile(LAYOUT_FILE, "utf8");
  assert.match(src, COOKIES_IMPORT, "root layout must import cookies() from next/headers");
  assert.match(src, COOKIES_CALL, "root layout must call cookies() to read the theme preference");
  assert.match(src, HTML_DATA_THEME_DYNAMIC, "root layout must render data-theme from the cookie value");
  assert.match(src, ROOT_PROVIDER);
  assert.equal(INLINE_THEME_SCRIPT.test(src), false, "root layout must not render theme scripts");
  assert.equal(SUPPRESS_HYDRATION.test(src), false, "theme runtime must not rely on hydration-warning suppression");
});

test("theme provider persists explicit choices via cookies, not localStorage", async () => {
  const src = await readFile(PROVIDER_FILE, "utf8");
  assert.match(src, COOKIE_READ, "client theme runtime must read document.cookie");
  assert.match(src, COOKIE_WRITE, "client theme runtime must write document.cookie via buildThemeCookie");
  assert.equal(NO_LOCAL_STORAGE.test(src), false, "cookie is the single source of truth — no localStorage");
  assert.equal(DANGEROUSLY_SET.test(src), false);
  assert.equal(SUPPRESS_HYDRATION.test(src), false);
});

test("brand CSS supports explicit dark and first-paint system dark without JavaScript", async () => {
  const src = await readFile(BRAND_BASE_FILE, "utf8");
  assert.match(src, EXPLICIT_DARK_SELECTOR);
  assert.match(src, SYSTEM_MEDIA);
});

test("brand CSS gives status badges dedicated accessible foreground tokens", async () => {
  const src = await readFile(BRAND_BASE_FILE, "utf8");
  assert.match(src, STATUS_BADGE_FOREGROUND_TOKENS);
  assert.match(src, STATUS_BADGE_SEMANTIC_COLOR_RULES);
});

test("Tailwind dark variant follows explicit dark theme attributes", async () => {
  const src = await readFile(GLOBALS_FILE, "utf8");
  assert.match(src, DATA_THEME_DARK_VARIANT);
});
