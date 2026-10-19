// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Deterministic scan of spec-core.md for RFC 2119 requirement sentences.
//
// The matrix is a hand-transcribed inventory; this scan is the independent
// check that the transcription is complete. It splits the spec into sentences
// (table rows and list items are units of their own, never merged with their
// neighbours) and reports every sentence carrying an uppercase keyword. The
// scan knows nothing about the matrix: the completeness test compares the two.

const SECTION_HEADING = /^## (?:(\d+)\.|Appendix ([A-Z])\b)/;
const SUBSECTION_HEADING = /^#{3,6} (.+?)(?: \{#[^}]+\})?$/;
const LIST_ITEM = /^\s*(?:[-*]|\d+\.)\s+/;
const QUOTE_MARKER = /^\s*>\s?/;
const TABLE_CELL_BREAK = /(?<!\\)\|/;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z`"'([])/;
const MUST_FAMILY = /\b(?:MUST NOT|MUST|SHALL NOT|SHALL|REQUIRED)\b/;
const MUST_KEYWORD_GLOBAL = /\b(?:MUST NOT|MUST|SHALL NOT|SHALL|REQUIRED)\b/g;
const SHOULD_FAMILY = /\b(?:SHOULD NOT|SHOULD|RECOMMENDED|NOT RECOMMENDED)\b/;
const BOLD = /\*\*/g;
const WHITESPACE = /\s+/g;
const ESCAPED_PIPE = /\\\|/g;
/** A leading "Label:" such as a bold list-item label; stripped when matching a sentence to a clause. */
const LEADING_LABEL = /^[A-Z][A-Za-z0-9 \-/]{0,40}: (?=[A-Z])/;
const WORD_BREAK = / (?=\S)/g;
const MIN_TAIL_QUOTE = 20;
const MAX_LOCATOR_WIDTH = 8;

export type KeywordFamily = "must" | "should";

export interface SpecSentence {
  readonly family: KeywordFamily | undefined;
  readonly inFence: boolean;
  /** 1-indexed line of spec-core.md the sentence starts on. */
  readonly line: number;
  /** Section number (the N of "## N.") or appendix letter, or "" before the first heading. */
  readonly section: string;
  readonly subsection: string;
  /** Normalized sentence text. */
  readonly text: string;
}

export function stripLeadingLabel(text: string): string {
  return text.replace(LEADING_LABEL, "");
}

/** Whitespace and markdown-emphasis normalization shared by the scan and the matrix text. */
export function normalizeSpecText(text: string): string {
  return text.replace(BOLD, "").replace(ESCAPED_PIPE, "|").replace(WHITESPACE, " ").trim();
}

interface SourceLine {
  readonly line: number;
  readonly text: string;
}

interface Unit {
  readonly inFence: boolean;
  /** True when the unit began as a bullet or numbered list item. */
  readonly isListItem: boolean;
  readonly lines: readonly SourceLine[];
  readonly section: string;
  readonly subsection: string;
}

type LineKind = "fence" | "fenced" | "section" | "subsection" | "blank" | "row" | "text";

function classifyLine(raw: string, inFence: boolean): LineKind {
  if (raw.trimStart().startsWith("```")) {
    return "fence";
  }
  if (inFence) {
    return "fenced";
  }
  if (SECTION_HEADING.test(raw)) {
    return "section";
  }
  if (SUBSECTION_HEADING.test(raw)) {
    return "subsection";
  }
  if (!raw.trim()) {
    return "blank";
  }
  return raw.trimStart().startsWith("|") ? "row" : "text";
}

/** Groups spec lines into units: paragraphs, list items, table rows, fenced lines. */
function collectUnits(specLines: readonly string[]): readonly Unit[] {
  const units: Unit[] = [];
  let section = "";
  let subsection = "";
  let inFence = false;
  let open: SourceLine[] = [];

  let openIsListItem = false;
  const push = (lines: readonly SourceLine[], fenced: boolean, isListItem = false) => {
    units.push({ lines, inFence: fenced, isListItem, section, subsection });
  };
  const flush = () => {
    if (open.length > 0) {
      push(open, false, openIsListItem);
      open = [];
    }
    openIsListItem = false;
  };

  for (const [index, raw] of specLines.entries()) {
    const line = index + 1;
    const kind = classifyLine(raw, inFence);
    if (kind === "fenced") {
      push([{ line, text: raw }], true);
      continue;
    }
    if (kind === "text") {
      if (LIST_ITEM.test(raw)) {
        flush();
        openIsListItem = true;
      }
      open.push({ line, text: raw.replace(LIST_ITEM, "").replace(QUOTE_MARKER, "") });
      continue;
    }
    flush();
    if (kind === "fence") {
      inFence = !inFence;
    } else if (kind === "section") {
      const heading = SECTION_HEADING.exec(raw);
      section = heading?.[1] ?? heading?.[2] ?? "";
      subsection = "";
    } else if (kind === "subsection") {
      subsection = SUBSECTION_HEADING.exec(raw)?.[1] ?? "";
    } else if (kind === "row") {
      push([{ line, text: raw }], false);
    }
  }
  flush();
  return units;
}

function familyOf(text: string): KeywordFamily | undefined {
  if (MUST_FAMILY.test(text)) {
    return "must";
  }
  return SHOULD_FAMILY.test(text) ? "should" : undefined;
}

/** Splits a unit into sentences, remembering the line each one starts on. */
function unitSentences(unit: Unit): readonly SpecSentence[] {
  const [firstLine] = unit.lines;
  if (!firstLine) {
    return [];
  }
  const isRow = firstLine.text.trimStart().startsWith("|");
  // Offset of each source line inside the joined text, to recover a start line.
  let joined = "";
  const starts: { line: number; offset: number }[] = [];
  for (const { line, text } of unit.lines) {
    starts.push({ line, offset: joined.length });
    joined += `${text.trim()} `;
  }
  const lineAt = (offset: number) => starts.filter((s) => s.offset <= offset).at(-1)?.line ?? firstLine.line;

  const out: SpecSentence[] = [];
  let pieceOffset = 0;
  for (const piece of isRow ? joined.split(TABLE_CELL_BREAK) : [joined]) {
    const pieceStart = Math.max(joined.indexOf(piece, pieceOffset), 0);
    pieceOffset = pieceStart + piece.length;
    let cursor = 0;
    for (const raw of piece.split(SENTENCE_BREAK)) {
      const at = Math.max(piece.indexOf(raw, cursor), 0);
      cursor = at + raw.length;
      const text = normalizeSpecText(raw);
      if (text) {
        out.push({
          line: isRow ? firstLine.line : lineAt(pieceStart + at),
          text,
          section: unit.section,
          subsection: unit.subsection,
          inFence: unit.inFence,
          family: familyOf(text),
        });
      }
    }
  }
  return out;
}

/** Every sentence of the spec that carries an uppercase MUST-family or SHOULD-family keyword. */
export function scanSpecSentences(specText: string): readonly SpecSentence[] {
  return collectUnits(specText.split("\n"))
    .flatMap(unitSentences)
    .filter((s) => s.family !== undefined);
}

/**
 * Builds a lookup from verbatim spec text to the 1-indexed line it starts on.
 *
 * The narrowest window of consecutive lines that contains the text wins, which
 * pins a list item or wrapped paragraph to its first line. Text that occurs
 * twice resolves to the earlier occurrence.
 */
export function makeSpecLocator(specText: string): (fragment: string) => number | undefined {
  const lines = specText.split("\n");
  const windows = Array.from({ length: MAX_LOCATOR_WIDTH }, (_, w) =>
    Array.from({ length: Math.max(lines.length - w, 0) }, (_unused, i) =>
      normalizeSpecText(lines.slice(i, i + w + 1).join(" "))
    )
  );
  return (fragment) => {
    const needle = normalizeSpecText(fragment);
    const at = windows.map((row) => row.findIndex((window) => window.includes(needle))).find((i) => i !== -1);
    return at === undefined ? undefined : at + 1;
  };
}

/**
 * Splits clause text at "[...]" elisions. Each fragment is verbatim spec text;
 * the clause as a whole quotes the sentence with the elided part omitted.
 */
export function clauseFragments(text: string): readonly string[] {
  return text
    .split("[...]")
    .map(normalizeSpecText)
    .filter((f) => f.length > 0);
}

function wordStarts(text: string): readonly number[] {
  return [0, ...[...text.matchAll(WORD_BREAK)].map((m) => (m.index ?? 0) + 1)];
}

function occurrences(haystack: string, needle: string): readonly number[] {
  const found: number[] = [];
  let from = haystack.indexOf(needle);
  while (needle && from !== -1) {
    found.push(from);
    from = haystack.indexOf(needle, from + 1);
  }
  return found;
}

/** Character ranges of `sentence` that `fragment` quotes verbatim, whole or as a tail that runs on past the sentence. */
function quotedRanges(sentence: string, fragment: string): readonly (readonly [number, number])[] {
  const ranges = occurrences(sentence, fragment).map((at) => [at, at + fragment.length] as const);
  const tailStart = wordStarts(sentence).find((start) => fragment.includes(sentence.slice(start)));
  if (tailStart !== undefined && sentence.length - tailStart >= MIN_TAIL_QUOTE) {
    ranges.push([tailStart, sentence.length] as const);
  }
  return ranges;
}

/**
 * True when every uppercase MUST-family keyword in `rawSentence` lies inside a
 * stretch of the sentence that some clause quotes verbatim.
 *
 * A clause may quote a whole sentence, a tail of it ("a conforming server MUST
 * NOT ..."), or elide a middle with "[...]". All are accepted; what is not
 * accepted is a keyword that no clause text reaches, because that obligation is
 * then invisible to every coverage number.
 */
export function everyKeywordQuoted(rawSentence: string, clauseTexts: readonly string[]): boolean {
  const sentence = stripLeadingLabel(rawSentence);
  if (clauseTexts.some((text) => normalizeSpecText(text).includes(sentence))) {
    return true;
  }
  const covered = clauseTexts
    .flatMap(clauseFragments)
    .flatMap((fragment) => [fragment, stripLeadingLabel(fragment)])
    .flatMap((fragment) => quotedRanges(sentence, fragment));
  return [...sentence.matchAll(MUST_KEYWORD_GLOBAL)].every((match) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return covered.some(([a, b]) => a <= start && end <= b);
  });
}

/** A MUST-family lead-in sentence ending in ":" and the list items it governs. */
export interface SpecLeadIn {
  readonly items: readonly { readonly line: number; readonly text: string }[];
  readonly leadIn: string;
  readonly line: number;
}

/**
 * Finds "X MUST include:" lead-ins and the list that follows. The list items are
 * part of the obligation, but the sentence scan sees each item as its own
 * keyword-free unit, so a clause that kept the MUST and dropped an item would
 * pass `everyKeywordQuoted`. Binding the items here lets the completeness test
 * demand every one of them.
 *
 * Works on the same units as the sentence scan, so layouts Markdown allows all
 * resolve alike: a lead-in wrapped over several lines, blank lines between the
 * lead-in and its list or between items, items wrapped over several lines, and
 * bullet or numbered lists. The list ends at the first non-list unit or heading.
 *
 * Section 9 is skipped: it is the index of one-line precis, not a clause source
 * (the matrix quotes Core's own sections), so its numbered items are not
 * governed here.
 */
export function scanLeadIns(specText: string): readonly SpecLeadIn[] {
  const units = collectUnits(specText.split("\n"));
  const found: SpecLeadIn[] = [];
  for (const [index, unit] of units.entries()) {
    const [first] = unit.lines;
    if (!first || unit.inFence || unit.isListItem || unit.section === "9" || first.text.trimStart().startsWith("|")) {
      continue;
    }
    const leadIn = unitSentences(unit).at(-1);
    if (!leadIn?.text.endsWith(":") || leadIn.family !== "must") {
      continue;
    }
    const items: { line: number; text: string }[] = [];
    for (const next of units.slice(index + 1)) {
      const [head] = next.lines;
      if (!(head && next.isListItem) || next.section !== unit.section || next.subsection !== unit.subsection) {
        break;
      }
      items.push({ line: head.line, text: normalizeSpecText(next.lines.map((l) => l.text).join(" ")) });
    }
    if (items.length > 0) {
      found.push({ line: leadIn.line, leadIn: leadIn.text, items });
    }
  }
  return found;
}

/**
 * Lead-in items no clause quotes. Candidate clauses are those that quote the
 * lead-in's own keyword; each item must appear verbatim in one of them.
 */
export function leadInGaps(specText: string, clauseTexts: readonly string[]): readonly string[] {
  const gaps: string[] = [];
  for (const { line, leadIn, items } of scanLeadIns(specText)) {
    const candidates = clauseTexts.filter((text) => everyKeywordQuoted(leadIn, [text])).map(normalizeSpecText);
    for (const item of items) {
      if (!candidates.some((text) => text.includes(item.text))) {
        gaps.push(`L${item.line}: "${item.text}" (governed by L${line}: ${leadIn})`);
      }
    }
  }
  return gaps;
}
