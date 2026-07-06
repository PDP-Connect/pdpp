import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}[[...path]]/page.tsx`;

const REPAIR_COPY_RE = /This installed app opened an old route/;
const CLEAN_LINKS_RE = /href:\s*"\/"[\s\S]*href:\s*"\/sources"[\s\S]*href:\s*"\/syncs"[\s\S]*href:\s*"\/notifications"/;
const ROBOTS_NOINDEX_RE = /robots:\s*\{ index:\s*false, follow:\s*false, nocache:\s*true \}/;
const DOCUMENT_NAVIGATION_GATE_RE = /headers\(\)[\s\S]*accept[\s\S]*text\/html[\s\S]*notFound\(\)/;
const REDIRECT_RE = /redirect\(/;

test("stale dashboard PWA route renders bounded repair instead of redirecting", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, REPAIR_COPY_RE);
  assert.match(src, CLEAN_LINKS_RE);
  assert.match(src, ROBOTS_NOINDEX_RE);
  assert.match(src, DOCUMENT_NAVIGATION_GATE_RE);
  assert.doesNotMatch(src, REDIRECT_RE);
});
