// Runtime DOM regression coverage for the hosted MCP consent picker.
//
// Every other picker test asserts the rendered HTML/markup or the server-side
// POST outcome. None of them RUN the inline picker `<script>`. That left a real
// gap: the picker's interaction model (collapse-by-default, derive-source-from-
// streams, single-stream selection, client-side submit validation, bulk
// controls) lived entirely in browser JS that no test exercised, so a
// regression in that script would pass the whole suite while reproducing the
// exact symptoms a human reported in live UAT:
//
//   - all sources expanded by default
//   - nothing selected, yet every stream appeared selected
//   - selecting one stream without "select all" was confusing/impossible
//   - a stream selected without its parent produced a raw JSON invalid_request
//
// This file loads the real picker HTML the AS renders and executes its script
// in a real DOM (jsdom), then drives the picker the way a person would and
// asserts the resulting DOM state. It fails on each of the UAT regressions
// above at the level they were actually observed: in-browser behavior.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { JSDOM } from 'jsdom';

import { canonicalConnectorKeyFromManifest } from '../server/connector-key.js';
import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function registerFixture(asUrl, fixtureName) {
  const raw = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, `manifests/${fixtureName}.json`), 'utf8'));
  const canonical = canonicalConnectorKeyFromManifest(raw);
  const manifest = canonical && canonical !== raw.connector_id ? { ...raw, connector_id: canonical } : raw;
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(resp.status, 201, `register ${fixtureName}`);
  return manifest;
}

async function registerClient(asUrl) {
  const resp = await fetch(`${asUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Hosted MCP picker runtime client',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(resp.status, 201);
  return await resp.json();
}

function startOpenTestServer() {
  return startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:', ownerAuthPassword: '' });
}

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

// Boot the AS, register two same-shape connectors, and fetch the live picker
// HTML the way the browser would (GET /oauth/authorize with no
// authorization_details / connector_id). Returns a jsdom window with the inline
// picker script executed, plus helpers to drive and inspect it.
async function openPickerDom() {
  const server = await startOpenTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  await registerFixture(asUrl, 'spotify');
  await registerFixture(asUrl, 'github');
  const client = await registerClient(asUrl);

  const verifier = randomBytes(32).toString('base64url');
  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('state', 'runtime-state');
  authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const pickerResp = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(pickerResp.status, 200);
  const html = await pickerResp.text();

  // runScripts: 'dangerously' executes the inline picker <script>, wiring the
  // real event listeners the browser would. The IIFE also runs its initial
  // syncSource pass on load, exactly as in a browser.
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { document } = dom.window;
  const form = document.querySelector('[data-hosted-mcp-picker-form]');
  assert.ok(form, 'picker form must render');

  const sources = () => Array.from(document.querySelectorAll('[data-hosted-mcp-source]'));
  const sourceBoxes = () => Array.from(document.querySelectorAll('[data-hosted-mcp-source-checkbox]'));
  const streamBoxes = () => Array.from(document.querySelectorAll('[data-hosted-mcp-stream-checkbox]'));
  const streamsIn = (source) => Array.from(source.querySelectorAll('[data-hosted-mcp-stream-checkbox]'));
  const sourceBoxIn = (source) => source.querySelector('[data-hosted-mcp-source-checkbox]');
  const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  const click = (selector) => document.querySelector(selector)?.click();
  // Dispatch a cancelable submit and report whether the picker JS prevented it.
  const submit = () => {
    let prevented = false;
    const evt = new dom.window.Event('submit', { bubbles: true, cancelable: true });
    const original = dom.window.Event.prototype.preventDefault;
    evt.preventDefault = function patched() {
      prevented = true;
      original.call(this);
    };
    form.dispatchEvent(evt);
    return prevented;
  };
  const errorEl = () => form.querySelector('[data-hosted-mcp-picker-error]');

  return {
    server, dom, document, form,
    sources, sourceBoxes, streamBoxes, streamsIn, sourceBoxIn,
    fire, click, submit, errorEl,
    async close() { await closeServer(server); },
  };
}

test('picker runtime: all sources render collapsed by default (no auto-expand)', async () => {
  const p = await openPickerDom();
  try {
    assert.ok(p.sources().length >= 2, 'fixture should render at least two sources');
    assert.ok(p.sources().every((s) => !s.open), 'no <details> source may start open');
  } finally {
    await p.close();
  }
});

test('picker runtime: nothing is selected on load (no phantom all-streams-selected)', async () => {
  const p = await openPickerDom();
  try {
    assert.ok(p.sourceBoxes().length >= 2 && p.streamBoxes().length >= 2, 'render must contain pickable boxes');
    // After the IIFE's on-load syncSource pass, the human must see zero selection.
    assert.ok(p.sourceBoxes().every((b) => !b.checked), 'no source checkbox may start checked');
    assert.ok(p.sourceBoxes().every((b) => !b.indeterminate), 'no source checkbox may start indeterminate');
    assert.ok(p.streamBoxes().every((b) => !b.checked), 'no stream checkbox may start checked');
    assert.ok(p.sources().every((s) => s.dataset.sourceSelected === 'false'), 'every source must report data-source-selected="false"');
  } finally {
    await p.close();
  }
});

test('picker runtime: a single stream can be selected without selecting the whole source', async () => {
  const p = await openPickerDom();
  try {
    const source = p.sources()[0];
    const streams = p.streamsIn(source);
    assert.ok(streams.length >= 2, 'need a multi-stream source for this assertion');

    // Check exactly one stream and fire its change event (a real user click).
    streams[0].checked = true;
    p.fire(streams[0], 'change');

    const checkedInSource = p.streamsIn(source).filter((s) => s.checked).length;
    assert.equal(checkedInSource, 1, 'selecting one stream must NOT cascade to its siblings');

    const sourceBox = p.sourceBoxIn(source);
    assert.equal(sourceBox.checked, true, 'one selected stream marks its parent source selected');
    assert.equal(sourceBox.indeterminate, true, 'a partial stream selection leaves the parent indeterminate, not fully checked');
    assert.equal(source.dataset.sourceSelected, 'true', 'the source must report selected once a stream is checked');
  } finally {
    await p.close();
  }
});

test('picker runtime: toggling the source checkbox selects every stream (whole-source)', async () => {
  const p = await openPickerDom();
  try {
    const source = p.sources()[0];
    const sourceBox = p.sourceBoxIn(source);
    sourceBox.checked = true;
    p.fire(sourceBox, 'change');

    const streams = p.streamsIn(source);
    assert.ok(streams.length > 0);
    assert.ok(streams.every((s) => s.checked), 'checking the source must check all of its streams');
    assert.equal(sourceBox.indeterminate, false, 'a fully-selected source is not indeterminate');
  } finally {
    await p.close();
  }
});

test('picker runtime: an empty submit is blocked in-browser with an inline error (never a raw JSON path)', async () => {
  const p = await openPickerDom();
  try {
    const prevented = p.submit();
    assert.equal(prevented, true, 'submitting with nothing selected must be prevented client-side');
    const err = p.errorEl();
    assert.ok(err && !err.hidden, 'an inline validation error must be shown');
    assert.ok(err.textContent.trim().length > 0, 'the inline error must carry guidance text');
  } finally {
    await p.close();
  }
});

test('picker runtime: a valid single-stream selection submits (not prevented)', async () => {
  const p = await openPickerDom();
  try {
    const stream = p.sources()[0].querySelector('[data-hosted-mcp-stream-checkbox]');
    stream.checked = true;
    p.fire(stream, 'change');
    const prevented = p.submit();
    assert.equal(prevented, false, 'a valid one-stream selection must be allowed to submit');
  } finally {
    await p.close();
  }
});

test('picker runtime: bulk controls behave distinctly (select / clear / expand / collapse)', async () => {
  const p = await openPickerDom();
  try {
    // Select all → every stream checked, every source selected.
    p.click('[data-hosted-mcp-select-sources]');
    assert.ok(
      p.streamBoxes().filter((b) => !b.disabled).every((b) => b.checked),
      'Select all must check every enabled stream'
    );

    // Clear all → nothing checked, but selection clearing must NOT silently
    // collapse rows the way Select all must NOT force them open. (Select all is
    // a selection action, not a disclosure action.)
    p.click('[data-hosted-mcp-clear-sources]');
    assert.ok(p.streamBoxes().every((b) => !b.checked), 'Clear all must uncheck every stream');
    assert.ok(p.sourceBoxes().every((b) => !b.checked), 'Clear all must uncheck every source');

    // Expand all / Collapse all are pure disclosure controls.
    p.click('[data-hosted-mcp-expand-all]');
    assert.ok(p.sources().every((s) => s.open), 'Expand all must open every source');
    p.click('[data-hosted-mcp-collapse-all]');
    assert.ok(p.sources().every((s) => !s.open), 'Collapse all must close every source');
  } finally {
    await p.close();
  }
});

test('picker runtime: clearing a source via its per-source button collapses only that source', async () => {
  const p = await openPickerDom();
  try {
    const source = p.sources()[0];
    // Select the whole source (opens it), then use the per-source clear button.
    const sourceBox = p.sourceBoxIn(source);
    sourceBox.checked = true;
    p.fire(sourceBox, 'change');
    assert.equal(source.open, true, 'selecting a source opens it');

    source.querySelector('[data-hosted-mcp-clear-streams]')?.click();
    assert.ok(p.streamsIn(source).every((s) => !s.checked), 'per-source clear unchecks its streams');
    assert.equal(source.open, false, 'per-source clear collapses that source');
    assert.equal(source.dataset.sourceSelected, 'false', 'per-source clear deselects the source');
  } finally {
    await p.close();
  }
});
