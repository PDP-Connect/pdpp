// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOSTED_UI_CSS,
  readHostedThemeChoiceFromCookieHeader,
  renderHostedDocument,
} from '../server/hosted-ui.js';

test('hosted owner UI supports CSS-only dark mode for login and approval pages', () => {
  assert.match(HOSTED_UI_CSS, /@media \(prefers-color-scheme: dark\)/);
  assert.match(HOSTED_UI_CSS, /color-scheme:\s*dark/);
  assert.match(HOSTED_UI_CSS, /html\[data-theme="dark"\]/);
  assert.match(HOSTED_UI_CSS, /html\[data-theme="system"\]/);
  assert.match(HOSTED_UI_CSS, /--background:\s*oklch\(0\.16/);
  assert.match(HOSTED_UI_CSS, /--card:\s*oklch\(0\.205/);
});

test('hosted owner documents stay framework-free while loading the shared stylesheet', () => {
  const html = renderHostedDocument({
    title: 'PDPP Reference Provider - Owner sign-in',
    providerName: 'PDPP Reference Provider',
    body: '<section class="hosted-ui-surface" data-surface="human">Sign in</section>',
  });

  assert.match(html, /<link rel="stylesheet" href="\/__pdpp\/hosted-ui\.css" \/>/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /data-pdpp-hosted-ui/);
});

test('hosted owner documents honor the dashboard theme cookie when present', () => {
  assert.equal(readHostedThemeChoiceFromCookieHeader('pdpp-theme=dark'), 'dark');
  assert.equal(readHostedThemeChoiceFromCookieHeader('other=1; pdpp-theme=light'), 'light');
  assert.equal(readHostedThemeChoiceFromCookieHeader('pdpp-theme=invalid'), 'system');

  const html = renderHostedDocument({
    title: 'PDPP Reference Provider - Owner sign-in',
    providerName: 'PDPP Reference Provider',
    body: '<section class="hosted-ui-surface" data-surface="human">Sign in</section>',
    themeChoice: 'dark',
  });

  assert.match(html, /<html lang="en" data-theme="dark">/);
});
