// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { renderMermaidSVG } from "beautiful-mermaid";
import { normalizeMermaidSvgFont } from "./mermaid-svg.ts";

const GOOGLE_FONT_URL = /fonts\.googleapis\.com/;
const QUOTED_INHERIT_FONT = /font-family: 'inherit'/;
const CSS_INHERIT_FONT = /text \{ font-family: inherit; \}/;

test("Mermaid diagrams inherit the site font without requesting a bogus Google font", () => {
  const svg = normalizeMermaidSvgFont(
    renderMermaidSVG("flowchart TD\n A-->B", {
      font: "inherit",
      transparent: true,
    })
  );

  assert.doesNotMatch(svg, GOOGLE_FONT_URL);
  assert.doesNotMatch(svg, QUOTED_INHERIT_FONT);
  assert.match(svg, CSS_INHERIT_FONT);
});
