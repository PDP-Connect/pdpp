// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Prose gate for the root `spec-*.md` files.
//
// Every rule below traces to a published style authority, cited in RULES so a
// reviewer can check the rule against its source instead of against taste. The
// rubric in docs/reference/spec-writing-rubric.md carries the judged criteria
// that no regex can decide.
//
// Usage:
//   node scripts/spec-prose-lint.mjs                 # every root spec-*.md
//   node scripts/spec-prose-lint.mjs spec-core.md    # named files only
//   node scripts/spec-prose-lint.mjs --fix           # rejoin hard-wrapped prose
//   node scripts/spec-prose-lint.mjs --format=json   # machine-readable findings
//
// Exits 1 when any finding remains, 0 when clean.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// RFC 2119 / RFC 8174 key words. RFC 8174 is explicit that these carry
// normative force "only when they appear in all capitals", so the case of a
// match is the whole signal both keyword rules turn on.
const KEYWORDS = ["MUST NOT", "MUST", "SHALL NOT", "SHALL", "SHOULD NOT", "SHOULD", "REQUIRED", "RECOMMENDED", "NOT RECOMMENDED", "MAY", "OPTIONAL"];

// Lowercase key words are ordinary English (RFC 8174) and appear legitimately
// all over the specs. Two narrowings keep this rule precise enough to gate on,
// both established by checking the rule's hits against the real specs:
//
//   * Only obligation verbs. Lowercase "may" is nearly always descriptive --
//     "a resource server may hold pre-collected data" states a possibility, not
//     a permission grant -- and flagging it produced nine false positives for
//     every true one. "must" and "shall" after a role are the shape that reads
//     as a requirement while carrying none.
//   * Only where a protocol role governs the verb, so ordinary prose like
//     "these must not be conflated" is left alone.
const ROLES = "(?:the |a |an |any |each |every )?(?:AS|RS|authorization server|resource server|personal server|client|connector|implementation|implementer|producer|consumer)";
const LOWERCASE_NORMATIVE = new RegExp(`\\b${ROLES}\\s+(?:must not|must|shall not|shall)\\b`, "i");

// Filler and meta-commentary. Each entry is a phrase that adds no information
// to a specification sentence: either it announces what the prose is about to
// do, or it is a marketing adjective with no testable meaning.
//
// Edit this list to tune the rule. Keep entries lowercase and free of regex
// syntax; they are matched literally, on a word boundary, against lowercased
// text. Add a phrase only when you can say what a reader loses by keeping it.
const FILLER = [
  "it is worth noting",
  "it should be noted",
  "it is important to",
  "in order to",
  "this section describes",
  "this section will",
  "note that",
  "importantly",
  "robust",
  "seamless",
  "seamlessly",
  "leverage",
  "leverages",
  "leveraging",
  "utilize",
  "utilizes",
  "delve",
  "a wide range of",
  "best-in-class",
  "cutting-edge",
  "state-of-the-art",
];

const MAX_SENTENCE_WORDS = 40;

// Rule table. `id` appears in output; `cite` is the authority a reviewer checks.
const RULES = [
  { id: "hard-wrap", cite: "RFC 7322 §2 — consistency within a document", why: "A hard-wrapped paragraph produces line-level diff noise on every reflow and hides real edits inside whitespace churn. The root specs mix both styles today, so the rule picks the unwrapped one." },
  { id: "lowercase-normative", cite: "RFC 8174 — key words apply 'only when they appear in all capitals'", why: "A lowercase key word governing a protocol role reads like an obligation but imposes none, so implementers and the conformance suite disagree about what is required." },
  { id: "keyword-in-note", cite: "W3C Manual of Style — 'notes are assumed to always be informative'; spec-core.md:112 says the same", why: "A note is non-normative by declaration, so a capitalized key word inside one states a requirement the document has already disclaimed." },
  { id: "long-sentence", cite: "W3C Manual of Style, Grammar — 'Break long sentences'; ASD-STE100 rule 3.2 caps descriptive sentences at 25 words", why: "A sentence past 40 words usually carries more than one requirement, and a reader cannot tell which clause the conformance obligation attaches to." },
  { id: "filler", cite: "Zinsser, On Writing Well ch.2-3 (clutter); ASD-STE100 §1 (one meaning per word)", why: "Meta-commentary and unfalsifiable adjectives take a reader's attention without narrowing what an implementation must do." },
  { id: "duplicate-paragraph", cite: "RFC 7322 §2 (consistency); DRY as applied to normative text", why: "Two copies of a requirement drift apart under edit, and a reader has no way to tell which copy is current." },
];

export { RULES };

// Classify every line once. Rules consult this instead of re-deriving context.
function scan(lines) {
  const ctx = [];
  let inFence = false;
  let inFrontMatter = false;
  for (const [i, raw] of lines.entries()) {
    const line = raw ?? "";
    const trimmed = line.trim();
    if (i === 0 && trimmed === "---") {
      inFrontMatter = true;
      ctx.push({ kind: "meta" });
      continue;
    }
    if (inFrontMatter) {
      if (trimmed === "---") inFrontMatter = false;
      ctx.push({ kind: "meta" });
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      ctx.push({ kind: "fence" });
      continue;
    }
    if (inFence) {
      ctx.push({ kind: "code" });
      continue;
    }
    if (trimmed === "") ctx.push({ kind: "blank" });
    // `Status: Normative draft` / `Date: 2026-08-29` headers sit at the top of
    // every spec. They are field lines, not a wrapped paragraph.
    else if (/^[A-Z][A-Za-z-]{1,20}:\s+\S/.test(line) && !/[.!?]\s*$/.test(trimmed)) ctx.push({ kind: "meta" });
    else if (/^\s*\|/.test(line)) ctx.push({ kind: "table" });
    else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) ctx.push({ kind: "list" });
    else if (/^\s*#{1,6}\s/.test(line)) ctx.push({ kind: "heading" });
    else if (/^\s{4,}\S/.test(line)) ctx.push({ kind: "code" });
    else if (/^\s*>/.test(line)) ctx.push({ kind: "quote" });
    else ctx.push({ kind: "prose" });
  }
  return ctx;
}

// A note block: a "Note"/"Non-normative" lead-in paragraph, through the blank
// line that ends it.
function noteLines(lines, ctx) {
  const flagged = new Set();
  let open = false;
  for (const [i, raw] of lines.entries()) {
    const kind = ctx[i].kind;
    if (kind === "code" || kind === "fence" || kind === "meta") continue;
    if (kind === "blank") {
      open = false;
      continue;
    }
    // Matches "**Note:**", "**Note on X:**", "Note:", "> **Note:**".
    if (/^\s*>?\s*(?:\*\*)?(?:Note|Non-normative note|Editor's note|Informative note)\b[^*\n]*(?:\*\*)?\s*:/i.test(raw)) open = true;
    if (open) flagged.add(i);
  }
  return flagged;
}

// (a) Hard-wrapped prose: a prose line that ends mid-sentence and is continued
// by the next prose line. Tables, lists, code, headings and quotes are exempt.
function findHardWraps(lines, ctx) {
  const pairs = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (ctx[i].kind !== "prose" || ctx[i + 1].kind !== "prose") continue;
    const cur = lines[i].trimEnd();
    const next = lines[i + 1].trim();
    if (cur === "" || next === "") continue;
    // Ends mid-sentence: no terminal punctuation, no colon introducing a block.
    if (/[.!?:;]\s*$/.test(cur)) continue;
    // A trailing pipe or backslash is table/continuation syntax, not prose.
    if (/[|\\]$/.test(cur)) continue;
    // The continuation must read as more of the same sentence, i.e. it does
    // not start a new one with a heading marker or a capitalized new clause
    // that follows a full stop (already excluded above).
    if (/^[#>|]/.test(next)) continue;
    pairs.push(i);
  }
  return pairs;
}

// (c) Sentence length. Split on terminal punctuation followed by whitespace,
// guarding the abbreviations and version strings the specs actually contain.
function sentencesOf(text) {
  const guarded = text
    .replace(/\b(e\.g|i\.e|etc|cf|vs|Fig|Sec|No|Dr|Mr|Ms|St|approx|al)\./gi, "$1<DOT>")
    .replace(/\bv(\d+)\.(\d+)(?:\.(\d+))?/g, (m) => m.replace(/\./g, "<DOT>"))
    .replace(/(\d)\.(\d)/g, "$1<DOT>$2")
    .replace(/§\s*\d+(?:\.\d+)*/g, (m) => m.replace(/\./g, "<DOT>"));
  return guarded
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/<DOT>/g, ".").trim())
    .filter(Boolean);
}

function wordCount(sentence) {
  // Inline code, URLs and link targets are one token to a reader, not many.
  const flattened = sentence
    .replace(/`[^`]*`/g, " CODE ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " URL ");
  return flattened.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

export function lintFile(file, source) {
  const findings = [];
  const record = (rule, f, line, text) => findings.push({ rule, file: f, line, text: text.trim().slice(0, 160) });
  const lines = source.split("\n");
  const ctx = scan(lines);
  const notes = noteLines(lines, ctx);

  for (const i of findHardWraps(lines, ctx)) {
    record("hard-wrap", file, i + 1, lines[i]);
  }

  for (const [i, raw] of lines.entries()) {
    const kind = ctx[i].kind;
    if (kind === "code" || kind === "fence" || kind === "meta") continue;

    // (b) lowercase key word doing normative work, outside notes (a note is
    // informative, so lowercase there is correct by construction).
    if (!notes.has(i)) {
      const m = raw.match(LOWERCASE_NORMATIVE);
      // Only a genuinely lowercase match counts; the regex is case-insensitive
      // so it also matches correctly-capitalized text.
      if (m && m[0] === m[0].toLowerCase()) record("lowercase-normative", file, i + 1, `"${m[0]}" in: ${raw.trim()}`);
    }

    // (f) capitalized key word inside a note block.
    if (notes.has(i)) {
      const hit = KEYWORDS.find((k) => new RegExp(`(?<![A-Za-z0-9_\`])${k}(?![A-Za-z0-9_\`])`).test(raw));
      if (hit) record("keyword-in-note", file, i + 1, raw);
    }

    // (d) filler and meta-commentary. Table cells count: the prose in a
    // description column is still prose a reader must get through.
    if (kind !== "heading") {
      const lowered = raw.toLowerCase();
      for (const phrase of FILLER) {
        if (new RegExp(`(?<![a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`).test(lowered)) {
          record("filler", file, i + 1, `"${phrase}" in: ${raw.trim()}`);
        }
      }
    }

    // (c) sentence length, prose and table cells only.
    if (kind === "prose" || kind === "list" || kind === "quote" || kind === "table") {
      const body = kind === "table" ? raw.split("|").join(" ") : raw;
      for (const sentence of sentencesOf(body)) {
        const n = wordCount(sentence);
        if (n > MAX_SENTENCE_WORDS) record("long-sentence", file, i + 1, `${n} words: ${sentence}`);
      }
    }
  }

  // (e) duplicated paragraphs. Compare normalized prose blocks of substance;
  // short blocks and boilerplate note lead-ins repeat legitimately.
  const seen = new Map();
  let buf = [];
  let start = 0;
  const flush = () => {
    if (buf.length) {
      const text = buf.join(" ").replace(/\s+/g, " ").trim();
      const key = text.toLowerCase().replace(/[^a-z0-9 ]/g, "");
      if (wordCount(text) >= 12) {
        if (seen.has(key)) record("duplicate-paragraph", file, start + 1, `duplicate of line ${seen.get(key) + 1}: ${text}`);
        else seen.set(key, start);
      }
    }
    buf = [];
  };
  for (const [i, raw] of lines.entries()) {
    const kind = ctx[i].kind;
    if (kind === "prose") {
      if (!buf.length) start = i;
      buf.push(raw.trim());
    } else flush();
  }
  flush();
  return findings;
}

// --fix rejoins hard-wrapped prose. It is the only mechanical fix here: every
// other rule needs a decision about meaning that the tool must not make.
export function fixHardWraps(source) {
  let lines = source.split("\n");
  for (let pass = 0; pass < 200; pass++) {
    const ctx = scan(lines);
    const pairs = findHardWraps(lines, ctx);
    if (!pairs.length) break;
    const i = pairs[0];
    lines = [...lines.slice(0, i), `${lines[i].trimEnd()} ${lines[i + 1].trim()}`, ...lines.slice(i + 2)];
  }
  return lines.join("\n");
}

function main(argv) {
  const fix = argv.includes("--fix");
  const json = argv.includes("--format=json");
  const named = argv.filter((a) => !a.startsWith("--"));
  const files = named.length ? named : readdirSync(".").filter((f) => /^spec-.*\.md$/.test(f)).sort();

  if (!files.length) {
    process.stderr.write("spec-prose-lint: no spec-*.md files to check\n");
    return 0;
  }

  const findings = [];
  let fixed = 0;
  let unreadable = false;
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      process.stderr.write(`spec-prose-lint: cannot read ${file}\n`);
      unreadable = true;
      continue;
    }
    if (fix) {
      const next = fixHardWraps(source);
      if (next !== source) {
        writeFileSync(file, next);
        fixed++;
        source = next;
      }
    }
    findings.push(...lintFile(file, source));
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ findings, files }, null, 2)}\n`);
    return findings.length || unreadable ? 1 : 0;
  }

  for (const f of findings) process.stdout.write(`${f.file}:${f.line}: ${f.rule}: ${f.text}\n`);
  if (findings.length) {
    const byRule = new Map();
    for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
    process.stdout.write(`\n${findings.length} finding(s) across ${files.length} file(s)\n`);
    for (const rule of RULES) {
      const n = byRule.get(rule.id) ?? 0;
      if (n) process.stdout.write(`  ${rule.id}: ${n}  [${rule.cite}]\n`);
    }
    process.stdout.write("\nRule rationale is in docs/reference/spec-writing-rubric.md.\n");
  } else {
    process.stdout.write(`spec-prose-lint: clean (${files.length} file(s))\n`);
  }
  if (fix && fixed) process.stdout.write(`--fix rejoined hard-wrapped prose in ${fixed} file(s)\n`);
  return findings.length || unreadable ? 1 : 0;
}

// Importing this file for tests must not run the CLI or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
