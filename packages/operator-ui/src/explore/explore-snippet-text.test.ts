/**
 * Lexical search-hit snippets carry `<mark>…</mark>` highlight markup. The feed
 * renders the snippet as plain React text (dangerouslySetInnerHTML is guarded),
 * so the assembler must strip the markup before it reaches a row — otherwise the
 * owner sees literal `<mark>stream</mark>` machinery instead of their text.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { plainSnippetText, snippetSegments } from "./explore-data-assembler.ts";

test("plainSnippetText strips <mark> highlight tags", () => {
  assert.equal(plainSnippetText('the <mark>stream</mark>":"<mark>messages</mark>'), 'the stream":"messages');
  assert.equal(plainSnippetText("<MARK>Case</MARK> insensitive"), "Case insensitive");
});

test("plainSnippetText leaves unmarked text untouched", () => {
  assert.equal(plainSnippetText("plain message body"), "plain message body");
  assert.equal(plainSnippetText(""), "");
});

test("plainSnippetText decodes entities the markup wrapper introduces, &amp; last", () => {
  assert.equal(plainSnippetText("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(plainSnippetText("&lt;not a tag&gt;"), "<not a tag>");
  assert.equal(plainSnippetText("say &quot;hi&quot; it&#39;s fine"), `say "hi" it's fine`);
  // &amp; must decode LAST so an already-escaped entity does not get re-decoded.
  assert.equal(plainSnippetText("&amp;lt;"), "&lt;");
});

test("plainSnippetText never emits a residual <mark> tag", () => {
  const out = plainSnippetText("<mark>a</mark> b <mark>c</mark> d");
  assert.ok(!(out.includes("<mark>") || out.includes("</mark>")), out);
  assert.equal(out, "a b c d");
});

// snippetSegments keeps the <mark> structure (decoded) so the row can bold the
// matched terms — the same text plainSnippetText flattens for the aria haystack.
test("snippetSegments splits marked from unmarked runs", () => {
  assert.deepEqual(snippetSegments("Should we <mark>deploy</mark> a function"), [
    { marked: false, text: "Should we " },
    { marked: true, text: "deploy" },
    { marked: false, text: " a function" },
  ]);
});

test("snippetSegments returns one unmarked segment when nothing matched", () => {
  assert.deepEqual(snippetSegments("just plain text"), [{ marked: false, text: "just plain text" }]);
});

test("snippetSegments decodes entities inside and outside marks, never leaks a tag", () => {
  const segs = snippetSegments("Tom &amp; <mark>Jerry &lt;3</mark>");
  assert.deepEqual(segs, [
    { marked: false, text: "Tom & " },
    { marked: true, text: "Jerry <3" },
  ]);
  for (const seg of segs) {
    assert.ok(!(seg.text.includes("<mark>") || seg.text.includes("</mark>")), seg.text);
  }
});

test("snippetSegments concatenated text equals plainSnippetText", () => {
  const raw = "the <mark>stream</mark>\":\"<mark>messages</mark> body";
  assert.equal(
    snippetSegments(raw)
      .map((s) => s.text)
      .join(""),
    plainSnippetText(raw)
  );
});
