#!/usr/bin/env node
// Single-source the normative spec docs.
//
// The repository root holds the normative `spec-*.md` files (source of truth).
// The docs site renders them from `content/docs/spec-*.md`, which need MDX
// frontmatter (title/description) and a `<Callout>` status banner that the
// plain root files do not carry. Rather than keep hand-edited copies in sync
// (they drift — an edit to a root spec silently leaves the site stale), we
// GENERATE the site copies at build time:
//
//     content/docs/<spec>.md  =  spec-headers/<spec>.header.md
//                                + the root spec body (header stripped)
//
// The header sidecars are committed (site-owned presentation) and live OUTSIDE
// content/docs so fumadocs does not glob them as doc pages. The generated
// `content/docs/spec-*.md` files are gitignored and untracked, so the root
// files are the single source for all normative body text.
//
// Runs from `predev` and `prebuild`. Vercel builds from apps/site with the
// monorepo root available, so the relative path to the repo root resolves.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(scriptDir, '..');
const repoRoot = path.join(siteDir, '..', '..');
const contentDir = path.join(siteDir, 'content', 'docs');
const headerDir = path.join(siteDir, 'spec-headers');

// The normative spec files that are single-sourced from the repo root.
// Non-spec docs (reference-implementation*, open-questions, extension specs,
// index, README) live only under content/docs and are NOT touched here.
const SPECS = [
  'spec-architecture',
  'spec-auth-design',
  'spec-change-tracking',
  'spec-collection-profile',
  'spec-connector-ecosystem',
  'spec-core',
  'spec-data-query-api',
  'spec-deferred',
];

// Root header shape (uniform across all spec files):
//   line 1: `# <Title>`
//   line 2: (blank)
//   line 3: `Status: ...`
//   line 4: `Date: ...`
//   line 5: (blank)
//   line 6+: body — sometimes led by a stray `---` horizontal rule that the
//            site drops because the frontmatter block already separates head
//            from body.
function extractBody(rootText, specName) {
  const lines = rootText.split('\n');

  if (!lines[0]?.startsWith('# ')) {
    throw new Error(
      `sync-spec-docs: ${specName}.md: expected a '# Title' heading on line 1, got: ${JSON.stringify(lines[0])}`
    );
  }
  if (!lines[2]?.startsWith('Status:') || !lines[3]?.startsWith('Date:')) {
    throw new Error(
      `sync-spec-docs: ${specName}.md: expected 'Status:'/'Date:' on lines 3-4; header shape changed. ` +
        `Update scripts/sync-spec-docs.mjs to match the new root format.`
    );
  }

  const status = lines[2].slice('Status:'.length).trim();
  const date = lines[3].slice('Date:'.length).trim();

  // Drop the four header lines, then any leading blank lines.
  let body = lines.slice(4);
  while (body.length && body[0].trim() === '') body.shift();

  // Drop a leading horizontal rule + following blanks (header/body separator).
  if (body[0] === '---') {
    body.shift();
    while (body.length && body[0].trim() === '') body.shift();
  }

  return { status, date, body: body.join('\n') };
}

// The header sidecar mirrors the root Status/Date inside its <Callout>. Root is
// the source of truth; warn loudly if they drift so the sidecar gets updated
// rather than silently rendering a stale status banner.
function checkStatusDateDrift(header, root, spec) {
  const statusMatch = header.match(/Status:\s*\*\*(.+?)\*\*/);
  const dateMatch = header.match(/Date:\s*(.+)/);
  const sideStatus = statusMatch?.[1]?.trim();
  const sideDate = dateMatch?.[1]?.trim();

  if (sideStatus && sideStatus !== root.status) {
    console.warn(
      `[sync-spec-docs] WARNING ${spec}: Callout Status "${sideStatus}" != root "${root.status}". ` +
        `Update apps/site/spec-headers/${spec}.header.md to match the root spec.`
    );
  }
  if (sideDate && sideDate !== root.date) {
    console.warn(
      `[sync-spec-docs] WARNING ${spec}: Callout Date "${sideDate}" != root "${root.date}". ` +
        `Update apps/site/spec-headers/${spec}.header.md to match the root spec.`
    );
  }
}

let generated = 0;
for (const spec of SPECS) {
  const rootPath = path.join(repoRoot, `${spec}.md`);
  const headerPath = path.join(headerDir, `${spec}.header.md`);
  const outPath = path.join(contentDir, `${spec}.md`);

  if (!existsSync(rootPath)) {
    throw new Error(`sync-spec-docs: missing root spec ${rootPath}`);
  }
  if (!existsSync(headerPath)) {
    throw new Error(`sync-spec-docs: missing header sidecar ${headerPath}`);
  }

  const header = readFileSync(headerPath, 'utf8').replace(/\s*$/, '');
  const root = extractBody(readFileSync(rootPath, 'utf8'), spec);
  checkStatusDateDrift(header, root, spec);

  // header (frontmatter + Callout) + blank line + normative body.
  const out = `${header}\n\n${root.body.replace(/\s*$/, '')}\n`;
  writeFileSync(outPath, out);
  generated += 1;
}

console.log(`[sync-spec-docs] generated ${generated} spec page(s) from root spec-*.md`);
