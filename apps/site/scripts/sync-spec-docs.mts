#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Single-source the normative spec docs.
//
// The repository root holds the normative `spec-*.md` files (source of truth).
// The docs site renders them from `content/docs/spec-*.mdx`, which need MDX
// frontmatter (title/description) and a `<Callout>` status banner that the
// plain root files do not carry. Rather than keep hand-edited copies in sync
// (they drift — an edit to a root spec silently leaves the site stale), we
// GENERATE the site copies at build time:
//
//     content/docs/<spec>.mdx  =  spec-headers/<spec>.header.md
//                                 + the root spec body (header stripped)
//
// The header sidecars are committed (site-owned presentation) and live OUTSIDE
// content/docs so fumadocs does not glob them as doc pages. The generated
// `content/docs/spec-*.mdx` files are gitignored and untracked, so the root
// files are the single source for all normative body text.
//
// Output is `.mdx`, NOT `.md`. In a `.md` file, fumadocs-mdx compiles in
// CommonMark mode, where `<Callout ...>` is a raw HTML block that runs to the
// first blank line: the tag AND the lines before that blank are dropped
// outright, so the wrapper never reaches the renderer and its opening content
// (the `Status:` line) disappears — the spec pages' own status banners
// rendered as bare paragraphs missing their `Status:` line. `.mdx` parses the
// JSX properly, so the callout renders as the real component (this is why the
// governance programme doc below has always used `.mdx`).
//
// Runs from `predev` and `prebuild`. Vercel builds from apps/site with the
// monorepo root available, so the relative path to the repo root resolves.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(scriptDir, "..");
const repoRoot = path.join(siteDir, "..", "..");
const contentDir = path.join(siteDir, "content", "docs");
const headerDir = path.join(siteDir, "spec-headers");

// The normative spec files that are single-sourced from the repo root.
// Non-spec docs (reference-implementation*, open-questions, extension specs,
// index, README) live only under content/docs and are NOT touched here.
const SPECS = [
  "spec-architecture",
  "spec-auth-design",
  "spec-change-tracking",
  "spec-collection-profile",
  "spec-connector-ecosystem",
  "spec-core",
  "spec-data-query-api",
  "spec-deferred",
  "spec-discovery-and-trust",
];

// The root specs use kramdown-style `{#id}` heading-id suffixes (see
// remark-legacy-heading-ids.ts) and, in one place, a literal `<` comparison
// operator in prose. Both are inert in the CommonMark reading GitHub and the
// old .md output gave them, but a real MDX compiler (which the .mdx output
// below now gets, so `<Callout>` renders as JSX instead of being dropped)
// treats `{` as the start of a JS expression and `<` as the start of a tag.
// `{#id}` on `{#ai-training-consent}` and `<` on "(exclusive, <)" both fail to
// parse as MDX. Rewrite just those two constructs into MDX-safe equivalents
// when generating the site copy; the root files stay untouched so GitHub
// rendering and this same substitution's own input are unaffected.
function toMdxSafe(body) {
  return (
    body
      // `## Heading {#id}` -> `## Heading [#id]`. Anchored to a heading line's
      // trailing `{#id}` only, so `{...}` used for any other reason (there is
      // none today) is left alone. Square brackets are ordinary prose text in
      // both CommonMark and MDX — no link/image syntax is triggered because
      // there is no following `(` or `[`. Trailing whitespace is matched with
      // `[ \t]*`, NOT `\s*` — `\s` matches newlines too, which silently ate
      // the blank line separating a heading from its first paragraph.
      .replace(/^(#{1,6} .*?)[ \t]*\{#([A-Za-z0-9_-]+)\}[ \t]*$/gm, "$1 [#$2]")
      // A bare `<` immediately followed by `)` reads to the MDX/JSX tokenizer
      // as the start of a tag name; `)` cannot start a tag name, so the parse
      // fails. Backtick-quoting it (already how this table quotes every other
      // token) makes the comparison operator literal.
      .replace("(exclusive, <), evaluated", "(exclusive, `<`), evaluated")
  );
}

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
  const lines = rootText.split("\n");

  if (!lines[0]?.startsWith("# ")) {
    throw new Error(
      `sync-spec-docs: ${specName}.md: expected a '# Title' heading on line 1, got: ${JSON.stringify(lines[0])}`
    );
  }
  if (!(lines[2]?.startsWith("Status:") && lines[3]?.startsWith("Date:"))) {
    throw new Error(
      `sync-spec-docs: ${specName}.md: expected 'Status:'/'Date:' on lines 3-4; header shape changed. ` +
        "Update scripts/sync-spec-docs.mjs to match the new root format."
    );
  }

  const status = lines[2].slice("Status:".length).trim();
  const date = lines[3].slice("Date:".length).trim();

  // Drop the four header lines, then any leading blank lines.
  const body = lines.slice(4);
  while (body.length && body[0].trim() === "") {
    body.shift();
  }

  // Drop a leading horizontal rule + following blanks (header/body separator).
  if (body[0] === "---") {
    body.shift();
    while (body.length && body[0].trim() === "") {
      body.shift();
    }
  }

  return { body: toMdxSafe(body.join("\n")), date, status };
}

// The header sidecar mirrors the root Status/Date inside its <Callout>. Root is
// the source of truth; warn loudly if they drift so the sidecar gets updated
// rather than silently rendering a stale status banner.
function checkStatusDateDrift(header, root, spec) {
  // biome-ignore lint/performance/useTopLevelRegex: Preserves an established runtime, ordering, accessibility, or source-shape contract; verified by the package typecheck and build.
  const statusMatch = header.match(/Status:\s*\*\*(.+?)\*\*/);
  // biome-ignore lint/performance/useTopLevelRegex: Preserves an established runtime, ordering, accessibility, or source-shape contract; verified by the package typecheck and build.
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
  const outPath = path.join(contentDir, `${spec}.mdx`);

  if (!existsSync(rootPath)) {
    throw new Error(`sync-spec-docs: missing root spec ${rootPath}`);
  }
  if (!existsSync(headerPath)) {
    throw new Error(`sync-spec-docs: missing header sidecar ${headerPath}`);
  }

  const header = readFileSync(headerPath, "utf8").replace(/\s*$/, "");
  const root = extractBody(readFileSync(rootPath, "utf8"), spec);
  checkStatusDateDrift(header, root, spec);

  // header (frontmatter + Callout) + blank line + normative body.
  const out = `${header}\n\n${root.body.replace(/\s*$/, "")}\n`;
  writeFileSync(outPath, out);
  generated += 1;
}

// Programme documents are single-sourced the same way, from a DIFFERENT root
// header shape. GOVERNANCE.md is not a spec: it carries a bolded `**Status:**`
// block with Circulated / Formal review / Programme live lines rather than the
// uniform `Status:`/`Date:` pair extractBody asserts on, and it is not under
// CSL-1.0 or amended through the Community Specification process. Running it
// through the spec path would throw on line 3; giving it its own path keeps the
// spec header contract strict rather than loosening it to accommodate a file
// that was never meant to satisfy it.
//
// The body is taken whole below the `# Title` line — the root document's own
// status block IS content here (it states the review window and the lock), so
// unlike the specs nothing is stripped but the heading the frontmatter replaces.
const PROGRAMME_DOCS = [{ header: "governance", root: "GOVERNANCE", slug: "governance" }];

function extractProgrammeBody(rootText: string, docName: string): string {
  const lines = rootText.split("\n");

  if (!lines[0]?.startsWith("# ")) {
    throw new Error(
      `sync-spec-docs: ${docName}.md: expected a '# Title' heading on line 1, got: ${JSON.stringify(lines[0])}`
    );
  }

  const body = lines.slice(1);
  while (body.length && body[0].trim() === "") {
    body.shift();
  }

  return body.join("\n");
}

for (const doc of PROGRAMME_DOCS) {
  const rootPath = path.join(repoRoot, `${doc.root}.md`);
  const headerPath = path.join(headerDir, `${doc.header}.header.md`);

  if (!existsSync(rootPath)) {
    throw new Error(`sync-spec-docs: missing root programme doc ${rootPath}`);
  }
  if (!existsSync(headerPath)) {
    throw new Error(`sync-spec-docs: missing header sidecar ${headerPath}`);
  }

  const header = readFileSync(headerPath, "utf8").replace(/\s*$/, "");
  const body = extractProgrammeBody(readFileSync(rootPath, "utf8"), doc.root);

  // .mdx, NOT .md — same reason as the spec loop above: emitting .mdx parses
  // the header sidecar's `<Callout>` as the real JSX component instead of
  // dropping it as a raw HTML block. Safe here because the governance body
  // contains no `<` or `{` for MDX to trip on.
  writeFileSync(path.join(contentDir, `${doc.slug}.mdx`), `${header}\n\n${body.replace(/\s*$/, "")}\n`);
  generated += 1;
}

// The spec's own front matter — version, status, date, editors — is emitted as
// a module here rather than read when a page renders.
//
// Vercel's project root is apps/site, so the repo root is present while this
// build script runs and absent from the serverless bundle that serves a
// request. `outputFileTracingIncludes` cannot bridge that: a path above the
// project root is dropped. Pages that read spec-core.md at request time
// returned 500 in production while passing every local check, because locally
// the server IS the repo. Reading at build time is the same single-sourcing
// the spec bodies above already use.
const maintainersPath = path.join(repoRoot, "MAINTAINERS.md");
if (!existsSync(maintainersPath)) {
  throw new Error(`sync-spec-docs: missing ${maintainersPath}`);
}
const specCoreText = readFileSync(path.join(repoRoot, "spec-core.md"), "utf8");
const specCoreLines = specCoreText.split("\n");

const versionMatch = (specCoreLines[0] || "").match(
  /^# Personal Data Portability Protocol \(PDPP\) (v\d+\.\d+\.\d+)\s*$/
);
if (!versionMatch) {
  throw new Error(
    `sync-spec-docs: spec-core.md line 1 is not "# Personal Data Portability Protocol (PDPP) vN.N.N" (got ${JSON.stringify(specCoreLines[0] ?? "")}).`
  );
}
const statusLine = specCoreLines.find((line) => line.startsWith("Status:"));
const status = statusLine?.slice("Status:".length).trim();
if (!status) {
  throw new Error("sync-spec-docs: spec-core.md has no non-empty 'Status:' line.");
}
const dateLine = specCoreLines.find((line) => line.startsWith("Date:"));
const date = dateLine?.slice("Date:".length).trim();
if (!(date && /^\d{4}-\d{2}-\d{2}$/.test(date))) {
  throw new Error(`sync-spec-docs: spec-core.md 'Date:' is not YYYY-MM-DD (got ${JSON.stringify(date ?? "")}).`);
}

// The "Active maintainers" table row: | Name | `@handle` | Scope | Active | ...
const ACTIVE_MAINTAINER_ROW = /^\|\s*([^|]+?)\s*\|\s*`@[^`]+`\s*\|[^|]*\|\s*Active\s*\|/;
const editors = readFileSync(maintainersPath, "utf8")
  .split("\n")
  .map((line) => line.match(ACTIVE_MAINTAINER_ROW)?.[1]?.trim())
  .filter((name): name is string => Boolean(name));
if (editors.length === 0) {
  throw new Error("sync-spec-docs: MAINTAINERS.md has no Active maintainer rows.");
}

const generatedDir = path.join(siteDir, "src", "generated");
mkdirSync(generatedDir, { recursive: true });
writeFileSync(
  path.join(generatedDir, "spec-front-matter.ts"),
  `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// GENERATED by scripts/sync-spec-docs.mjs from the repo-root spec-core.md and
// MAINTAINERS.md. Do not edit: run \`pnpm prebuild\` (or predev) instead.
export const SPEC_FRONT_MATTER = ${JSON.stringify({ date, editors, status, version: versionMatch[1] }, null, 2)} as const;
`
);

console.log(`[sync-spec-docs] generated ${generated} spec page(s) from root spec-*.md`);
console.log(
  `[sync-spec-docs] wrote src/generated/spec-front-matter.ts (${versionMatch[1]}, ${status}, ${date}, ${editors.length} editor(s))`
);
