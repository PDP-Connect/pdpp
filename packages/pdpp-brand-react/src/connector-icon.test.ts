// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ConnectorIcon has zero connector-specific knowledge: it renders exactly
 * what its `icon`/`name` props carry. These tests prove the fallback
 * (monogram) path, the manifest-declared inline_svg path, and that an
 * unrecognized icon.kind degrades to the fallback rather than throwing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectorIcon } from "./connector-icon.tsx";

const MONOGRAM_CLASS = /class="pdpp-monogram pdpp-monogram--tinted"/;
const ARIA_HIDDEN_TRUE = /aria-hidden="true"/;
const SPOTIFY_INITIALS_DATA = /data-initials="SP"/;
const HUE_VAR_RE = /--pdpp-monogram-hue:\s*(-?\d+)/;
const ICON_CLASS = /class="pdpp-connector-icon"/;
const SVG_VIEWBOX = /viewBox="0 0 24 24"/;
const SVG_COLOR_STYLE = /color:#1ED760/;

test("ConnectorIcon with no icon renders the deterministic monogram fallback", () => {
  const html = renderToStaticMarkup(createElement(ConnectorIcon, { name: "Spotify" }));
  assert.match(html, MONOGRAM_CLASS);
  assert.match(html, ARIA_HIDDEN_TRUE);
  assert.match(html, SPOTIFY_INITIALS_DATA);
});

test("ConnectorIcon fallback is deterministic across renders for the same name", () => {
  const first = renderToStaticMarkup(createElement(ConnectorIcon, { name: "Notion" }));
  const second = renderToStaticMarkup(createElement(ConnectorIcon, { name: "Notion" }));
  assert.equal(first, second);
});

test("ConnectorIcon fallback derives distinct hues for distinct names", () => {
  const a = renderToStaticMarkup(createElement(ConnectorIcon, { icon: undefined, name: "GitHub" }));
  const b = renderToStaticMarkup(createElement(ConnectorIcon, { icon: undefined, name: "Reddit" }));
  const hueOf = (html: string) => html.match(HUE_VAR_RE)?.[1];
  assert.notEqual(hueOf(a), hueOf(b));
});

test("ConnectorIcon renders a manifest-declared inline_svg icon verbatim", () => {
  const svg = '<svg role="img" viewBox="0 0 24 24"><path d="M12 0z"/></svg>';
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, { icon: { color: "#1ED760", kind: "inline_svg", svg }, name: "Spotify" })
  );
  assert.match(html, ICON_CLASS);
  assert.doesNotMatch(html, MONOGRAM_CLASS);
  assert.match(html, SVG_VIEWBOX);
  assert.match(html, SVG_COLOR_STYLE);
});

test("ConnectorIcon falls back to the monogram for an unrecognized icon.kind", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, { icon: { kind: "remote_url", svg: "irrelevant" }, name: "Slack" })
  );
  assert.match(html, MONOGRAM_CLASS);
});

test("ConnectorIcon falls back to the monogram when icon.svg is empty", () => {
  const html = renderToStaticMarkup(
    createElement(ConnectorIcon, { icon: { kind: "inline_svg", svg: "" }, name: "Slack" })
  );
  assert.match(html, MONOGRAM_CLASS);
});
