// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for two UNTESTED pure presentational helpers in
 * `server/hosted-ui.js`:
 *
 *   - normalizeHostedThemeChoice(value): a STRICT allowlist — returns the value
 *     only when it is exactly "light" | "dark" | "system"; everything else
 *     (unknown strings, null, mixed-case, padded) collapses to "system". It does
 *     NOT trim or lowercase, so "  DARK  " is not "dark".
 *
 *   - renderPdppMark({size, title}): builds the inline SVG brand mark. Defaults
 *     to size 28 / title "PDPP". A present title makes the mark an accessible
 *     image (`role="img"` + HTML-escaped `aria-label`); an empty title makes it
 *     decorative (`role="presentation"` + `aria-hidden="true"`, no aria-label).
 *     The title is HTML-escaped so it cannot break out of the attribute.
 *
 * Pure — the module has zero imports. No DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeHostedThemeChoice, renderPdppMark } from '../server/hosted-ui.js';

// --- normalizeHostedThemeChoice ---------------------------------------------

test('normalizeHostedThemeChoice: passes through the three exact valid choices', () => {
  assert.equal(normalizeHostedThemeChoice('light'), 'light');
  assert.equal(normalizeHostedThemeChoice('dark'), 'dark');
  assert.equal(normalizeHostedThemeChoice('system'), 'system');
});

test('normalizeHostedThemeChoice: anything else collapses to "system"', () => {
  assert.equal(normalizeHostedThemeChoice('bogus'), 'system', 'unknown string');
  assert.equal(normalizeHostedThemeChoice(null), 'system', 'null');
  assert.equal(normalizeHostedThemeChoice(undefined), 'system', 'undefined');
  assert.equal(normalizeHostedThemeChoice(''), 'system', 'empty string');
});

test('normalizeHostedThemeChoice: match is strict (no trim / no case-fold)', () => {
  assert.equal(normalizeHostedThemeChoice('  dark  '), 'system', 'padded value is not accepted');
  assert.equal(normalizeHostedThemeChoice('DARK'), 'system', 'uppercase is not accepted');
  assert.equal(normalizeHostedThemeChoice('Light'), 'system', 'mixed-case is not accepted');
});

// --- renderPdppMark ---------------------------------------------------------

test('renderPdppMark: defaults to size 28 and an accessible "PDPP" label', () => {
  const svg = renderPdppMark();
  assert.match(svg, /^<svg /, 'is an svg element');
  assert.ok(svg.includes('width="28" height="28"'), 'default size 28');
  assert.ok(svg.includes('role="img"'), 'present title => role="img"');
  assert.ok(svg.includes('aria-label="PDPP"'), 'default aria-label is PDPP');
  assert.ok(svg.includes('viewBox="0 0 200 200"'), 'fixed viewBox');
});

test('renderPdppMark: honors a custom size', () => {
  const svg = renderPdppMark({ size: 40, title: 'PDPP' });
  assert.ok(svg.includes('width="40" height="40"'), `custom size: ${svg.slice(0, 80)}`);
});

test('renderPdppMark: HTML-escapes the title so it cannot break the aria-label attribute', () => {
  const svg = renderPdppMark({ title: 'My <App> & "Co"' });
  assert.ok(svg.includes('aria-label="My &lt;App&gt; &amp; &quot;Co&quot;"'), `escaped label missing: ${svg}`);
  // The raw, unescaped title must NOT appear inside the attribute.
  assert.equal(svg.includes('aria-label="My <App>'), false, 'raw < must not leak into the attribute');
});

test('renderPdppMark: an empty title makes the mark decorative (presentation + aria-hidden, no label)', () => {
  const svg = renderPdppMark({ title: '' });
  assert.ok(svg.includes('role="presentation"'), 'empty title => role="presentation"');
  assert.ok(svg.includes('aria-hidden="true"'), 'empty title => aria-hidden');
  assert.equal(svg.includes('aria-label'), false, 'no aria-label for a decorative mark');
  assert.equal(svg.includes('role="img"'), false, 'not role="img" when decorative');
});
