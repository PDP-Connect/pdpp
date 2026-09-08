// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const INHERIT_FONT_IMPORT = /^\s*@import url\(['"]https:\/\/fonts\.googleapis\.com\/css2\?family=inherit:[^)]+\);\s*$/m;
const QUOTED_INHERIT_FONT = "text { font-family: 'inherit', system-ui, sans-serif; }";

export function normalizeMermaidSvgFont(svg: string) {
  return svg.replace(INHERIT_FONT_IMPORT, "").replace(QUOTED_INHERIT_FONT, "text { font-family: inherit; }");
}
