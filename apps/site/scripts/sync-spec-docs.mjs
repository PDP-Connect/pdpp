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
    return (body
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
        .replace("(exclusive, <), evaluated", "(exclusive, `<`), evaluated"));
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
        throw new Error(`sync-spec-docs: ${specName}.md: expected a '# Title' heading on line 1, got: ${JSON.stringify(lines[0])}`);
    }
    if (!(lines[2]?.startsWith("Status:") && lines[3]?.startsWith("Date:"))) {
        throw new Error(`sync-spec-docs: ${specName}.md: expected 'Status:'/'Date:' on lines 3-4; header shape changed. ` +
            "Update scripts/sync-spec-docs.mjs to match the new root format.");
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
        console.warn(`[sync-spec-docs] WARNING ${spec}: Callout Status "${sideStatus}" != root "${root.status}". ` +
            `Update apps/site/spec-headers/${spec}.header.md to match the root spec.`);
    }
    if (sideDate && sideDate !== root.date) {
        console.warn(`[sync-spec-docs] WARNING ${spec}: Callout Date "${sideDate}" != root "${root.date}". ` +
            `Update apps/site/spec-headers/${spec}.header.md to match the root spec.`);
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
// block with Circulated / Formal review / Programme live / Applies to lines
// rather than the uniform `Status:`/`Date:` pair extractBody asserts on, and it
// is not under CSL-1.0 or amended through the Community Specification process.
// Running it through the spec path would throw on line 3; giving it its own
// path keeps the spec header contract strict rather than loosening it to
// accommodate a file that was never meant to satisfy it.
//
// The body is taken from below the `# Title` line, with the seven-line
// `**Label:** value` status block also stripped (see stripGovernanceStatusBlock)
// for the SITE copy only: the rail card now renders those same facts (see
// GOVERNANCE_FRONT_MATTER below and rail.tsx), and a document has one status
// block — rendered chrome replaces the in-body list rather than sitting beside
// it. The root GOVERNANCE.md keeps the list; only the generated .mdx elides it.
const PROGRAMME_DOCS = [{ header: "governance", root: "GOVERNANCE", slug: "governance" }];
// Matches every label in the block, which is a superset of the labels the rail
// card sources from it (see requireGovernanceMatch below): Supporter signing
// opens and Reports are stripped from the site copy but have no rail row, so a
// label missing here would leak into the generated page body rather than throw.
// Anchored to `**Label:**` at the start of a line so it cannot match a
// similarly-worded sentence deeper in the document.
const GOVERNANCE_STATUS_LABEL_PATTERN = /^\*\*(?:Status|Circulated|Formal review|Supporter signing opens|Programme live|Applies to|Reports):\*\*.*$/;
function stripGovernanceStatusBlock(body) {
    const rest = [...body];
    while (rest.length && GOVERNANCE_STATUS_LABEL_PATTERN.test(rest[0] ?? "")) {
        rest.shift();
    }
    while (rest.length && rest[0].trim() === "") {
        rest.shift();
    }
    return rest;
}
function extractProgrammeBody(rootText, docName) {
    const lines = rootText.split("\n");
    if (!lines[0]?.startsWith("# ")) {
        throw new Error(`sync-spec-docs: ${docName}.md: expected a '# Title' heading on line 1, got: ${JSON.stringify(lines[0])}`);
    }
    let body = lines.slice(1);
    while (body.length && body[0].trim() === "") {
        body.shift();
    }
    body = stripGovernanceStatusBlock(body);
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
const versionMatch = (specCoreLines[0] || "").match(/^# Personal Data Portability Protocol \(PDPP\) (v\d+\.\d+\.\d+)\s*$/);
if (!versionMatch) {
    throw new Error(`sync-spec-docs: spec-core.md line 1 is not "# Personal Data Portability Protocol (PDPP) vN.N.N" (got ${JSON.stringify(specCoreLines[0] ?? "")}).`);
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
    .filter((name) => Boolean(name));
if (editors.length === 0) {
    throw new Error("sync-spec-docs: MAINTAINERS.md has no Active maintainer rows.");
}
// GOVERNANCE.md's own rail facts — Status / Circulated / Formal review /
// Programme live / Applies to — for the /governance rail card (see
// apps/site/src/components/specification/rail-context.tsx). Governance has no
// Editors row: the document is amended by a vote of Partners, not maintained
// the way the specification is (see MAINTAINERS.md).
//
// GOVERNANCE.md's header block (lines 3-9, one `**Label:** value` per line) is
// prose meant for a reader, not a machine-parseable field list — unlike
// spec-core.md's uniform `Status:`/`Date:` lines, so this reads each label by
// name and takes the rest of its line verbatim. A future rewording that drops
// or renames a label throws loudly rather than silently emitting a stale or
// empty rail row.
const governanceText = readFileSync(path.join(repoRoot, "GOVERNANCE.md"), "utf8");
function requireGovernanceMatch(pattern, fieldName) {
    const match = governanceText.match(pattern);
    const value = match?.[1]?.trim();
    if (!value) {
        throw new Error(`sync-spec-docs: GOVERNANCE.md header ${fieldName} line did not match the expected shape. ` +
            "Update scripts/sync-spec-docs.mts to match the new wording.");
    }
    return value;
}
function governanceHeaderPattern(label) {
    return new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+?)\\s*$`, "m");
}
const governanceStatus = requireGovernanceMatch(governanceHeaderPattern("Status"), "Status");
const governanceCirculated = requireGovernanceMatch(governanceHeaderPattern("Circulated"), "Circulated");
// The header states the review window as one range ("3 September to 1 October
// 2026"), so the rail row is that line verbatim. It was previously composed
// from separate Opens/Closes sentences.
const formalReview = requireGovernanceMatch(governanceHeaderPattern("Formal review"), "Formal review");
const governanceProgrammeLive = requireGovernanceMatch(governanceHeaderPattern("Programme live"), "Programme live");
const governanceAppliesTo = requireGovernanceMatch(governanceHeaderPattern("Applies to"), "Applies to");
const governanceFrontMatter = {
    status: governanceStatus,
    circulated: governanceCirculated,
    formalReview,
    programmeLive: governanceProgrammeLive,
    appliesTo: governanceAppliesTo,
};
const generatedDir = path.join(siteDir, "src", "generated");
mkdirSync(generatedDir, { recursive: true });
writeFileSync(path.join(generatedDir, "spec-front-matter.ts"), `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// GENERATED by scripts/sync-spec-docs.mjs from the repo-root spec-core.md,
// MAINTAINERS.md, and GOVERNANCE.md. Do not edit: run \`pnpm prebuild\` (or
// predev) instead.
export const SPEC_FRONT_MATTER = ${JSON.stringify({ date, editors, status, version: versionMatch[1] }, null, 2)} as const;
export const GOVERNANCE_FRONT_MATTER = ${JSON.stringify(governanceFrontMatter, null, 2)} as const;
`);
console.log(`[sync-spec-docs] generated ${generated} spec page(s) from root spec-*.md`);
console.log(`[sync-spec-docs] wrote src/generated/spec-front-matter.ts (${versionMatch[1]}, ${status}, ${date}, ${editors.length} editor(s); governance: ${governanceStatus})`);
