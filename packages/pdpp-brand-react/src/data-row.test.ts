import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Monogram } from "./data-row.tsx";

const MONOGRAM_CLASS = /class="pdpp-monogram"/;
const ARIA_HIDDEN_TRUE = /aria-hidden="true"/;
const CLAUDE_INITIALS_DATA = /data-initials="CL"/;
const CLAUDE_INITIALS_TEXT = />CL</;

test("Monogram renders decorative initials without polluting accessible labels", () => {
  const html = renderToStaticMarkup(createElement(Monogram, { name: "Claude" }));

  assert.match(html, MONOGRAM_CLASS);
  assert.match(html, ARIA_HIDDEN_TRUE);
  assert.match(html, CLAUDE_INITIALS_DATA);
  assert.doesNotMatch(html, CLAUDE_INITIALS_TEXT);
});
