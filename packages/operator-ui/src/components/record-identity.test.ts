import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type DeclaredFieldRoles, EMPTY_DECLARED_FIELD_ROLES } from "../lib/declared-field-roles.ts";
import { classifyRecordKind, type DeclaredFieldTypes } from "../lib/record-kind.ts";
import { buildRecordPreview } from "../lib/record-preview.ts";
import { kindGlyph, RecordIdentity, type RecordIdentityVariant, recordIdentityView } from "./record-identity.tsx";

// ─── Minimal CSS-cascade resolver ───────────────────────────────────────────
// renderToStaticMarkup produces no computed style, so a class-level assertion
// CANNOT catch a cascade-override defect (the brand stylesheet, not the DOM, is
// where the header variant could re-promote a derived UUID to a bold H1). This
// tiny resolver loads the REAL brand components.css, parses the .rr-x-identity*
// rules, and resolves a declared property for an element by full CSS specificity
// + source order — exactly the cascade that decides whether the derived header
// primary stays demoted. It is intentionally scoped to simple class selectors
// (which is all .rr-x-identity uses) — enough to pin THE defect, not a full engine.
const BRAND_CSS = readFileSync(
  fileURLToPath(new URL("../../../pdpp-brand-react/src/components.css", import.meta.url)),
  "utf8"
);

interface CssRule {
  classes: string[];
  decls: Record<string, string>;
  order: number;
  selector: string;
  specificity: number; // class-count is sufficient here (all selectors are class chains)
}

function parseIdentityRules(rawCss: string): CssRule[] {
  // Strip CSS comments first — the file's block comments contain braces that would
  // desync a naive rule tokenizer (the .rr-x-identity descriptions include `{`/`}`).
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let order = 0;
  let m: RegExpExecArray | null = ruleRe.exec(css);
  while (m !== null) {
    const selectorRaw = (m[1] ?? "").trim();
    const body = m[2] ?? "";
    // Only single-selector rules that target .rr-x-identity__primary (no commas in these).
    if (selectorRaw.includes(".rr-x-identity__primary") && !selectorRaw.includes(",")) {
      const classes = [...selectorRaw.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((c) => c[1] ?? "");
      // A :not(.is-derived) excludes that class — track it so we can honor it during matching.
      const notClasses = [...selectorRaw.matchAll(/:not\(\.([a-zA-Z0-9_-]+)\)/g)].map((c) => c[1] ?? "");
      const decls: Record<string, string> = {};
      for (const part of body.split(";")) {
        const idx = part.indexOf(":");
        if (idx > 0) {
          decls[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
        }
      }
      // Specificity here = number of class-like simple selectors incl. those inside :not().
      rules.push({
        classes: classes.filter((c) => !notClasses.includes(c)),
        decls,
        order: order++,
        selector: selectorRaw,
        // Store the :not exclusions on the rule via a sentinel property.
        specificity: classes.length,
        ...({ notClasses } as { notClasses: string[] }),
      } as CssRule & { notClasses: string[] });
    }
    m = ruleRe.exec(css);
  }
  return rules;
}

const IDENTITY_RULES = parseIdentityRules(BRAND_CSS);
const DERIVED_CLASS_RE = /is-derived/;
const IMAGE_MARK_RE = /rr-x-mark/;
const IMAGE_MARK_TEXT_RE = /rr-x-mark[^>]*>image</;
const KEY_CLASS_RE = /rr-x-identity__key/;
const MONEY_SYMBOL_RE = /\$/;
const PRIMARY_MONO_RE = /font-mono|rr-x-identity__key/;
const TABLE_OR_LIST_TAG_RE = /<(tr|td|th|li)[\s>]/;

/** Resolve a single CSS property for an element described by its full class set. */
function resolveProp(elementClasses: Set<string>, prop: string): string | undefined {
  let winner: { specificity: number; order: number; value: string } | undefined;
  for (const rule of IDENTITY_RULES) {
    const notClasses = (rule as CssRule & { notClasses?: string[] }).notClasses ?? [];
    const matches = rule.classes.every((c) => elementClasses.has(c)) && notClasses.every((c) => !elementClasses.has(c));
    if (!matches) {
      continue;
    }
    const value = rule.decls[prop];
    if (value === undefined) {
      continue;
    }
    if (
      !winner ||
      rule.specificity > winner.specificity ||
      (rule.specificity === winner.specificity && rule.order > winner.order)
    ) {
      winner = { order: rule.order, specificity: rule.specificity, value };
    }
  }
  return winner?.value;
}

/**
 * RecordIdentity — the anti-drift contract.
 *
 * The whole point of this cell is that a record renders the SAME identity on the
 * feed, the stream table, the mobile card, and the detail H1. These tests prove
 * that property at the DOM level: every variant, over one canonical preview,
 * produces an identical primary line + glyph + derived flag (T1), and the honesty
 * invariants (T2–T8, T11) hold in ONE place.
 */

const ALL_VARIANTS: RecordIdentityVariant[] = ["feed", "table-cell", "card", "header"];

// Build one canonical preview through the real engine — the SAME path every surface uses.
function previewFor(input: {
  stream: string;
  data: Record<string, unknown>;
  types?: DeclaredFieldTypes;
  roles?: DeclaredFieldRoles;
}) {
  const roles = input.roles ?? EMPTY_DECLARED_FIELD_ROLES;
  const types = input.types ?? {};
  const kind = classifyRecordKind(input.stream, input.data, types, undefined, roles).kind;
  return buildRecordPreview(kind, input.data, types, roles);
}

function dataAttr(html: string, name: string): string | null {
  // Extract the text content of the <span data-rr-x="name">…</span>, ignoring nested tags.
  const open = new RegExp(`<span[^>]*data-rr-x="${name}"[^>]*>`);
  const m = open.exec(html);
  if (!m) {
    return null;
  }
  const rest = html.slice(m.index + m[0].length);
  const close = rest.indexOf("</span>");
  const inner = close >= 0 ? rest.slice(0, close) : rest;
  // Strip any nested tags (e.g. the image mark) to get plain text.
  return inner.replace(/<[^>]*>/g, "");
}

function attrClass(html: string, name: string): string | null {
  const re = new RegExp(`<span[^>]*data-rr-x="${name}"[^>]*class="([^"]*)"`);
  const withClassFirst = re.exec(html);
  if (withClassFirst) {
    return withClassFirst[1] ?? null;
  }
  // class may appear before data-rr-x depending on prop order; try the reverse.
  const re2 = new RegExp(`<span[^>]*class="([^"]*)"[^>]*data-rr-x="${name}"`);
  const m = re2.exec(html);
  return m ? (m[1] ?? null) : null;
}

function derivedFlag(html: string, name: string): string | null {
  const re = new RegExp(`<span[^>]*data-rr-x="${name}"[^>]*data-derived="([^"]*)"`);
  const m = re.exec(html);
  if (m) {
    return m[1] ?? null;
  }
  const re2 = new RegExp(`<span[^>]*data-derived="([^"]*)"[^>]*data-rr-x="${name}"`);
  const m2 = re2.exec(html);
  return m2 ? (m2[1] ?? null) : null;
}

function renderVariant(
  variant: RecordIdentityVariant,
  preview: ReturnType<typeof previewFor>,
  recordKey: string,
  hasImage = false
): string {
  return renderToStaticMarkup(createElement(RecordIdentity, { hasImage, preview, recordKey, variant }));
}

// ─── Fixtures: one seeded record per identity case ──────────────────────────
const FIXTURES = {
  declaredTitle: {
    stream: "things",
    data: { subject: "Quarterly review notes", body: "long body here", id: "rec-1" },
    roles: { subject: "primary-title", body: "secondary" } as DeclaredFieldRoles,
    expectedPrimary: "Quarterly review notes",
    expectedDerived: false,
  },
  generic: {
    stream: "things",
    data: { color: "blue", note: "hello there" },
    expectedPrimary: "Color: blue",
    expectedDerived: true,
  },
  money: {
    stream: "transactions",
    data: { payee: "Coffee Shop", amount: 3000 },
    types: { amount: "currency" } as DeclaredFieldTypes,
    roles: { payee: "primary-title", amount: "amount" } as DeclaredFieldRoles,
    expectedPrimary: "Coffee Shop",
    expectedDerived: false,
  },
  idOnly: {
    stream: "opaque",
    data: { id: "550e8400-e29b-41d4-a716-446655440000", account_id: "acct-9" },
    recordKey: "550e8400-e29b-41d4-a716-446655440000",
    expectedPrimary: "550e8400-e29b-41d4-a716-446655440000",
    expectedDerived: true,
  },
};

test("T1 — same record renders an IDENTICAL primary + glyph + derived flag across all four surfaces", () => {
  for (const [name, fx] of Object.entries(FIXTURES)) {
    const recordKey = (fx as { recordKey?: string }).recordKey ?? "rec-key";
    const preview = previewFor(fx);
    const expectedGlyph = kindGlyph(preview?.kind ?? "generic");
    const primaries = new Set<string>();
    const glyphs = new Set<string>();
    const deriveds = new Set<string>();
    for (const variant of ALL_VARIANTS) {
      const html = renderVariant(variant, preview, recordKey);
      primaries.add(dataAttr(html, "primary") ?? "<<missing>>");
      glyphs.add(dataAttr(html, "glyph") ?? "<<missing>>");
      deriveds.add(derivedFlag(html, "primary") ?? "<<missing>>");
    }
    assert.equal(primaries.size, 1, `[${name}] primary text must be identical across surfaces`);
    assert.equal([...primaries][0], fx.expectedPrimary, `[${name}] primary text`);
    assert.equal(glyphs.size, 1, `[${name}] glyph must be identical across surfaces`);
    assert.equal([...glyphs][0], expectedGlyph, `[${name}] glyph`);
    assert.equal(deriveds.size, 1, `[${name}] derived flag must be identical across surfaces`);
    assert.equal([...deriveds][0], String(fx.expectedDerived), `[${name}] derived flag`);
  }
});

test("T2 — a declared-title record leads with the declared title, not derived", () => {
  const fx = FIXTURES.declaredTitle;
  const html = renderVariant("feed", previewFor(fx), "rec-1");
  assert.equal(dataAttr(html, "primary"), "Quarterly review notes");
  assert.equal(derivedFlag(html, "primary"), "false");
});

test("T3 — an undeclared record uses the first honest Label: value, derived, NOT a name-guessed title", () => {
  const fx = FIXTURES.generic;
  const html = renderVariant("feed", previewFor(fx), "rec-2");
  assert.equal(dataAttr(html, "primary"), "Color: blue");
  assert.equal(derivedFlag(html, "primary"), "true");
});

test("T4 — an id/uuid-only record never leads with the key as a bold title; key rides as the quiet token", () => {
  const fx = FIXTURES.idOnly;
  const html = renderVariant("feed", previewFor(fx), fx.recordKey);
  // The primary degrades to the neutral key fallback rendered DERIVED (quiet), never a confident title.
  assert.equal(derivedFlag(html, "primary"), "true");
  // The raw key appears in the dedicated quiet key token (feed shows the key token).
  assert.equal(dataAttr(html, "key"), fx.recordKey);
});

test("T4-header — an id/uuid-only record in the HEADER variant is DEMOTED in the CSS cascade, never a confident bold H1", () => {
  // The detail-page H1 consumer. For a content-free / id-only record buildRecordPreview
  // returns null and rowPrimary falls back to the raw record key (a UUID) as the primary.
  // THE-LENS Gate 1: "Raw snake_case/UUID is never an H1" — the header variant must KEEP
  // the demotion: the raw key renders as the quiet mono SECONDARY key treatment, NOT
  // inheriting the <h1>'s bold-700 foreground.
  const fx = FIXTURES.idOnly;
  const preview = previewFor(fx);
  const html = renderVariant("header", preview, fx.recordKey);
  // (1) The component retains the is-derived state on the header primary — without it the
  //     demotion CSS has nothing to hook onto.
  assert.equal(derivedFlag(html, "primary"), "true", "the derived header primary must retain data-derived=true");
  const primaryCls = attrClass(html, "primary") ?? "";
  assert.match(primaryCls, DERIVED_CLASS_RE, "the header primary must carry is-derived so the demotion CSS applies");
  assert.equal(dataAttr(html, "primary"), fx.recordKey, "the derived header primary is the record key, shown demoted");

  // (2) THE LOAD-BEARING ASSERTION (the actual defect lives in the CSS cascade, not the DOM):
  //     resolve the REAL brand stylesheet for a DERIVED header primary. The header variant must
  //     NOT blanket-inherit the heading weight/color for it — it must resolve to the demoted
  //     mono-secondary key treatment. Reverting the fix (header blanket-inherits for ALL
  //     primaries) makes `inherit` win here and this assertion fails (negative-controlled).
  const derivedHeader = new Set(["rr-x-identity__primary", "is-derived"]);
  // The element also sits under .rr-x-identity--header; our resolver matches on the full class
  // set, and the header rules reference the descendant .rr-x-identity__primary, so include it:
  derivedHeader.add("rr-x-identity--header");
  const weight = resolveProp(derivedHeader, "font-weight");
  const color = resolveProp(derivedHeader, "color");
  assert.notEqual(
    weight,
    "inherit",
    "a DERIVED header primary must NOT inherit the H1 weight (would become a bold UUID title)"
  );
  assert.notEqual(color, "inherit", "a DERIVED header primary must NOT inherit the H1 foreground color");
  assert.equal(weight, "400", "a derived header primary stays demoted weight-400, not the heading bold");
  assert.equal(color, "var(--muted-foreground)", "a derived header primary stays muted, not foreground");
  assert.equal(
    resolveProp(derivedHeader, "font-family"),
    "var(--font-mono)",
    "a derived header key-fallback renders as the mono key treatment (Gate-1: record key mono, secondary)"
  );

  // (3) A DECLARED title in the header, by contrast, must STILL inherit the real bold H1 —
  //     the fix must not regress real titles.
  const titled = renderVariant("header", previewFor(FIXTURES.declaredTitle), "rec-1");
  assert.equal(
    derivedFlag(titled, "primary"),
    "false",
    "a declared title in the header is NOT derived (stays a real H1)"
  );
  const titledCls = attrClass(titled, "primary") ?? "";
  assert.ok(!DERIVED_CLASS_RE.test(titledCls), "a declared header title must not carry is-derived");
  const declaredHeader = new Set(["rr-x-identity__primary", "rr-x-identity--header"]);
  assert.equal(
    resolveProp(declaredHeader, "font-weight"),
    "inherit",
    "a DECLARED header title still inherits the H1 weight (real titles stay bold)"
  );
  assert.equal(
    resolveProp(declaredHeader, "color"),
    "inherit",
    "a DECLARED header title still inherits the H1 foreground color"
  );
});

test("T5 — mono discipline: the primary is NEVER mono; the key token IS mono", () => {
  const html = renderVariant("feed", previewFor(FIXTURES.generic), "rec-x");
  const primaryCls = attrClass(html, "primary") ?? "";
  assert.ok(!PRIMARY_MONO_RE.test(primaryCls), "primary must not be mono");
  // The key token carries the mono class (rr-x-identity__key → font-mono in CSS).
  const keyCls = attrClass(html, "key") ?? "";
  assert.match(keyCls, KEY_CLASS_RE, "key token must be the mono key class");
});

test("T6 — money is declared-only: a currency-declared amount formats as money; the title is the declared payee", () => {
  const fx = FIXTURES.money;
  const preview = previewFor(fx);
  assert.equal(preview?.amount, "$30.00", "declared currency formats via formatDeclaredAmount");
  const html = renderVariant("feed", preview, "txn-1");
  assert.equal(dataAttr(html, "primary"), "Coffee Shop");
  // No fabricated $ on an undeclared number.
  const undeclared = previewFor({ stream: "opaque", data: { quantity: 4200, label: "Box" } });
  assert.ok(!MONEY_SYMBOL_RE.test(JSON.stringify(undeclared)), "an undeclared number must not gain a $");
});

test("T7 — the image mark appears ONLY from the surface-supplied hasImage prop, never a preview sniff", () => {
  const preview = previewFor(FIXTURES.generic);
  const without = renderVariant("feed", preview, "rec-3", false);
  assert.ok(!IMAGE_MARK_RE.test(without), "no image mark when hasImage is false");
  const withMark = renderVariant("feed", preview, "rec-3", true);
  assert.match(withMark, IMAGE_MARK_TEXT_RE, "the image mark renders when hasImage is true");
});

test("T8 — markup-neutral: the cell renders no <tr>/<td>/<li> (embeds in a table cell AND a feed list)", () => {
  for (const variant of ALL_VARIANTS) {
    const html = renderVariant(variant, previewFor(FIXTURES.declaredTitle), "rec-1");
    assert.ok(!TABLE_OR_LIST_TAG_RE.test(html), `[${variant}] must emit no table/list elements`);
  }
});

test("T11 — single glyph source: kindGlyph maps every kind and falls back to a neutral dot", () => {
  assert.equal(kindGlyph("money"), "$");
  assert.equal(kindGlyph("message"), "✉");
  assert.equal(kindGlyph("generic"), "•");
  assert.equal(kindGlyph(null), "•");
  assert.equal(kindGlyph(undefined), "•");
});

test("recordIdentityView reads engine slots without re-deriving (the adapter is pure projection)", () => {
  const preview = previewFor(FIXTURES.declaredTitle);
  const view = recordIdentityView(preview, "rec-1");
  assert.equal(view.primary, "Quarterly review notes");
  assert.equal(view.isDerived, false);
  assert.equal(view.kind, preview?.kind ?? "generic");
  // A null preview degrades to the key fallback, derived, never throwing.
  const empty = recordIdentityView(null, "fallback-key");
  assert.equal(empty.primary, "fallback-key");
  assert.equal(empty.isDerived, true);
  assert.equal(empty.kind, "generic");
});
