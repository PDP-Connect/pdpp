/**
 * Hosted MCP picker — render-layer regression lock-in.
 *
 * The hosted MCP picker UX (collapsed-by-default sources, bulk affordances,
 * nothing-preselected, no owner-visible URL/placeholder labels, orphaned-stream
 * rejection) was classified by the console functional-gap audit
 * (`tmp/workstreams/ri-console-functional-gap-audit-v1-report.md`, Gap 4) as
 * "Mostly FIXED — already at SLVP", with the explicit residual that **no
 * regression test pins the fixes at the render layer**. The existing coverage
 * proves the behavior through a live `/oauth/authorize` server round-trip
 * (`hosted-mcp-oauth.test.js`); a refactor of the pure HTML builder could
 * regress the UX without a live server in the loop.
 *
 * This suite locks the picker UX directly against the pure render helpers in
 * `server/routes/as-consent-ui-helpers.ts` — `renderHostedMcpSourceSelection`
 * and `listHostedMcpPickerRows` — with no DB and no HTTP. Production
 * primitives (`escapeHtml`, the selection encoders, `hostedMcpSourceKey`,
 * `canonicalConnectorKey`) are wired in exactly as `server/index.js` injects
 * them; only the async store reads and the presentational document wrappers
 * are faked. Assertions target stable semantic hooks (`data-hosted-mcp-*`,
 * `<details>`/`open`, `data-source-selected`) and owner-facing copy rather
 * than brittle whitespace.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalConnectorKey } from '../server/connector-key.js';
import {
  encodeHostedMcpSelection,
  encodeHostedMcpStreamSelection,
  hostedMcpSourceKey,
} from '../server/hosted-mcp-selection.js';
import { escapeHtml } from '../server/hosted-ui.js';
import {
  listHostedMcpPickerRows,
  renderHostedMcpSourceSelection,
} from '../server/routes/as-consent-ui-helpers.ts';

// ── Presentational renderer (pass-through) ───────────────────────────────────
// The real document/surface wrappers only add brand chrome around the picker
// body. We keep them as faithful pass-throughs so the inner picker markup —
// the thing every assertion below inspects — is preserved verbatim. Using the
// real `escapeHtml` keeps label-suppression assertions honest.
const ui = {
  escapeHtml,
  renderActionRow: (actions) => actions.map((a) => `<button>${escapeHtml(a.label)}</button>`).join('\n'),
  renderHostedDocument: ({ body }) => `<!doctype html><html><body>${body}</body></html>`,
  renderKeyValueList: (items) => items.map((i) => `<div>${escapeHtml(i.label)}</div>`).join('\n'),
  renderPageIntro: ({ title }) => `<h1>${escapeHtml(title)}</h1>`,
  renderResultState: ({ title, body }) => `<div>${escapeHtml(title)}${escapeHtml(body)}</div>`,
  renderSurface: ({ children }) => `<section>${children}</section>`,
};

// ── Fixture connector set ────────────────────────────────────────────────────
// Two registered connectors with URL-shaped ids (the first-party reference
// connectors are `https://registry.pdpp.org/connectors/<name>`), plus one
// internal connector that the picker MUST skip. Bindings carry deliberately
// adversarial display names to exercise the redundant/placeholder/URL label
// suppression path (`ownerFacingConnectionName`).

const SPOTIFY_ID = 'https://registry.pdpp.org/connectors/spotify';
const GITHUB_ID = 'https://registry.pdpp.org/connectors/github';
const INTERNAL_ID = 'pdpp-internal-audit';

const MANIFESTS = {
  [SPOTIFY_ID]: {
    display_name: 'Spotify',
    streams: [
      { name: 'saved_tracks', description: 'Tracks you saved' },
      { name: 'top_artists', description: null },
    ],
  },
  [GITHUB_ID]: {
    display_name: 'GitHub',
    streams: [
      { name: 'repositories', description: 'Repos you own' },
      { name: 'starred_repos', description: 'Repos you starred' },
      { name: 'issues', description: null },
    ],
  },
};

// Bindings keyed by connector id. The display names here are the suppression
// adversaries: a registry URL, a `cin_*` placeholder, and a label that simply
// echoes the connector label. None may surface as an owner-visible connection
// name. Spotify gets one binding with a genuinely useful, distinct name that
// MUST survive.
const BINDINGS = {
  [SPOTIFY_ID]: [
    { connectorInstanceId: 'cin_spotify_1', _display: 'Personal listening' },
  ],
  [GITHUB_ID]: [
    { connectorInstanceId: 'cin_github_url', _display: 'https://registry.pdpp.org/connectors/github' },
    { connectorInstanceId: 'cin_github_placeholder', _display: 'cin_github_placeholder' },
    { connectorInstanceId: 'cin_github_echo', _display: 'GitHub' },
  ],
};

function makeCaps(overrides = {}) {
  return {
    canonicalConnectorKey,
    encodeHostedMcpSelection,
    encodeHostedMcpStreamSelection,
    hostedMcpSourceKey,
    getConnectorManifest: async (connectorId) => MANIFESTS[connectorId] ?? null,
    isInternalConnectorId: (connectorId) => connectorId === INTERNAL_ID,
    listActiveBindingsForGrant: async ({ connectorId }) => BINDINGS[connectorId] ?? [],
    listRegisteredConnectorIds: async () => [SPOTIFY_ID, GITHUB_ID, INTERNAL_ID],
    projectBindingForWire: (conn) => ({
      display_name: conn._display ?? null,
      connection_id: conn.connectorInstanceId ?? null,
    }),
    ...overrides,
  };
}

const AUTHORIZE_QUERY = {
  client_id: 'client_demo',
  redirect_uri: 'https://client.example/callback',
  response_type: 'code',
  scope: 'mcp',
  state: 'render-test',
  code_challenge: 'a'.repeat(43),
  code_challenge_method: 'S256',
};

async function renderPicker(caps = makeCaps()) {
  return renderHostedMcpSourceSelection('owner_local', AUTHORIZE_QUERY, 'csrf-token', 'PDPP', caps, ui);
}

// Returns the array of full `<input ...>` tags matching a marker attribute.
function inputsWith(html, marker) {
  return [...html.matchAll(new RegExp(`<input[^>]*${marker}[^>]*>`, 'g'))].map((m) => m[0]);
}

function isChecked(tag) {
  return /\schecked(?:\s|\/|>|")/.test(tag);
}

// ── Acceptance criterion 1: sources collapsed by default ─────────────────────

test('every picker source <details> renders collapsed (no open attribute)', async () => {
  const html = await renderPicker();
  const details = [...html.matchAll(/<details class="hosted-ui-option-source"[^>]*>/g)].map((m) => m[0]);
  assert.ok(details.length >= 2, 'render must contain at least the two registered source <details>');
  for (const tag of details) {
    assert.equal(/\sopen(?:\s|>|")/.test(tag), false, 'source <details> must not carry the open attribute');
  }
});

// ── Acceptance criterion 2: bulk affordances present ─────────────────────────

test('picker exposes Select all / Clear all / Expand all / Collapse all controls', async () => {
  const html = await renderPicker();
  // Stable behavior hooks the picker JS binds to.
  assert.match(html, /data-hosted-mcp-select-sources/, 'select-all hook present');
  assert.match(html, /data-hosted-mcp-clear-sources/, 'clear-all hook present');
  assert.match(html, /data-hosted-mcp-expand-all/, 'expand-all hook present');
  assert.match(html, /data-hosted-mcp-collapse-all/, 'collapse-all hook present');
  // Owner-facing labels.
  assert.match(html, />Select all</, 'Select all is owner-labelled');
  assert.match(html, />Clear all</, 'Clear all is owner-labelled');
  assert.match(html, />Expand all</, 'Expand all is owner-labelled');
  assert.match(html, />Collapse all</, 'Collapse all is owner-labelled');
  // Per-source affordances too.
  assert.match(html, /data-hosted-mcp-select-streams/, 'per-source select-every-stream hook present');
  assert.match(html, /data-hosted-mcp-clear-streams/, 'per-source clear hook present');
});

// ── Acceptance criterion 3: nothing preselected on first render ──────────────

test('no source and no stream checkbox is checked on first render', async () => {
  const html = await renderPicker();
  const sourceBoxes = inputsWith(html, 'data-hosted-mcp-source-checkbox');
  const streamBoxes = inputsWith(html, 'data-hosted-mcp-stream-checkbox');

  // Guard against vacuous pass.
  assert.ok(sourceBoxes.length >= 2, 'render must contain source checkboxes');
  assert.ok(streamBoxes.length >= 2, 'render must contain stream checkboxes');

  assert.equal(sourceBoxes.filter(isChecked).length, 0, 'no source may be pre-checked');
  assert.equal(streamBoxes.filter(isChecked).length, 0, 'no stream may be pre-checked');

  // The derived "source participates" state must also start false everywhere,
  // so a source is never selected-with-streams-clear by default.
  const groups = [...html.matchAll(/<details class="hosted-ui-option-source"[^>]*>/g)].map((m) => m[0]);
  assert.equal(groups.length, sourceBoxes.length, 'one source group per source checkbox');
  for (const group of groups) {
    assert.match(group, /data-source-selected="false"/, 'each source group starts unselected');
  }
});

// ── Acceptance criterion 4: placeholder/URL labels not owner-visible ─────────

test('redundant URL / placeholder connection labels never surface as owner-visible names', async () => {
  const html = await renderPicker();

  // The connector id legitimately appears inside machine-only carriers — the
  // opaque `data-source-key` hook and the base64url `value="..."` form
  // payloads — so a blanket substring check would be wrong. "Owner-visible"
  // means rendered text nodes: the content between `>` and `<`. The three
  // adversarial GitHub bindings (URL display name, `cin_*` placeholder, label
  // echoing the connector) must produce NO visible label text.
  const textNodes = [...html.matchAll(/>([^<]+)</g)].map((m) => m[1]);
  for (const text of textNodes) {
    assert.equal(
      text.includes('https://registry.pdpp.org/connectors/github'),
      false,
      `a registry-URL display name must never render as visible text (saw: ${text.trim().slice(0, 60)})`,
    );
    assert.equal(
      text.includes('cin_github_placeholder'),
      false,
      `a cin_* placeholder must never render as visible text (saw: ${text.trim().slice(0, 60)})`,
    );
  }

  // Only Spotify's genuinely distinct name survives as a connection-name span.
  const connectionNames = [...html.matchAll(/<span class="hosted-ui-connection-name">([^<]*)<\/span>/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    connectionNames.sort(),
    ['Personal listening'],
    'only the distinct, non-redundant connection name is shown',
  );

  // The connector type label itself stays clean (no scheme leak in the row title).
  const typeLabels = [...html.matchAll(/<span class="hosted-ui-connector-type">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.ok(typeLabels.includes('Spotify') && typeLabels.includes('GitHub'), 'connector type labels are human names');
  for (const label of typeLabels) {
    assert.equal(label.includes('https'), false, 'connector type label must not leak a URL scheme');
  }
});

test('picker row meta never repeats a URL-shaped connector id as the technical key', async () => {
  const html = await renderPicker();
  const metas = [...html.matchAll(/<span class="hosted-ui-option-meta"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.ok(metas.length >= 2, 'each source row carries a meta line');
  for (const meta of metas) {
    assert.equal(meta.includes('https'), false, 'row meta must not echo a registry URL');
    assert.equal(meta.includes('/connectors/'), false, 'row meta must not echo a registry URL path');
    assert.match(meta, /streams? available/, 'row meta still summarizes available stream count');
  }
});

// ── listHostedMcpPickerRows: internal connectors excluded, labels canonical ──

test('listHostedMcpPickerRows skips internal connectors and emits canonical owner labels', async () => {
  const rows = await listHostedMcpPickerRows(makeCaps(), 'owner_local');

  // Internal connector excluded; Spotify (1 binding) + GitHub (3 bindings) = 4 rows.
  assert.equal(rows.length, 4, 'internal connector excluded; one row per active binding');
  assert.ok(
    rows.every((r) => r.connectorId !== INTERNAL_ID),
    'internal connector must never appear as a picker row',
  );

  // Connector type labels are the human manifest names, never the URL id.
  for (const row of rows) {
    assert.ok(['Spotify', 'GitHub'].includes(row.connectorTypeLabel), `clean type label, got ${row.connectorTypeLabel}`);
  }

  // GitHub's three adversarial binding names all suppress to null; Spotify's
  // distinct name survives.
  const names = rows.map((r) => r.connectionName).filter(Boolean);
  assert.deepEqual(names, ['Personal listening'], 'only the distinct connection name survives');
});

test('a connector with zero bindings still yields one unconfigured-connector row', async () => {
  const caps = makeCaps({
    listRegisteredConnectorIds: async () => [SPOTIFY_ID],
    listActiveBindingsForGrant: async () => [],
  });
  const rows = await listHostedMcpPickerRows(caps, 'owner_local');
  assert.equal(rows.length, 1, 'one connector-level row when no connections exist');
  assert.equal(rows[0].connectionId, null, 'unconfigured row has a null connection id');
  assert.equal(rows[0].connectorTypeLabel, 'Spotify');
});

// ── Acceptance criterion 5: orphaned-stream rejection is user-friendly ───────
// The server-side ignore-orphan-streams behavior is covered end-to-end in
// hosted-mcp-oauth.test.js. Here we pin the *render-layer* guards that make
// that path reachable without a raw-JSON error page: the client-side
// validation messages and the inline error banner the form surfaces instead.

test('picker carries the source-first validation guards and an inline error banner (no raw error page)', async () => {
  const html = await renderPicker();

  // The form-level error region the picker JS writes into (instead of
  // navigating to a JSON error). Starts hidden.
  const banner = html.match(/<div[^>]*data-hosted-mcp-picker-error[^>]*>/);
  assert.ok(banner, 'picker renders an inline error region');
  assert.match(banner[0], /role="alert"/, 'error region is an assertive live region');
  assert.match(banner[0], /\shidden(?:\s|>|")/, 'error region starts hidden');

  // The two guard messages that keep an orphaned stream / sourceless submit
  // from ever reaching the server as a confusing grant.
  assert.match(html, /Select at least one source/i, 'guards against a sourceless submit');
  assert.match(
    html,
    /Choose at least one stream inside each selected source/i,
    'guards against a selected source with no checked stream',
  );

  // The picker JS derives the source checkbox from its checked streams, so a
  // source cannot stay selected while every stream is clear — the structural
  // root of the "stream-without-source" defect.
  assert.match(html, /sourceBox\.checked = selected/, 'source checked state is derived from streams');
  assert.match(html, /event\.preventDefault\(\)/, 'invalid submits are blocked client-side, not posted raw');
});

// ── Empty-state: no sources registered ───────────────────────────────────────

test('empty connector set renders a calm owner message with no form controls', async () => {
  const caps = makeCaps({ listRegisteredConnectorIds: async () => [INTERNAL_ID] });
  const html = await renderPicker(caps);
  assert.match(html, /No sources are available on this server yet/i, 'owner sees a plain empty-state message');
  assert.equal(inputsWith(html, 'data-hosted-mcp-source-checkbox').length, 0, 'no source checkboxes in empty state');
  assert.equal(html.includes('data-hosted-mcp-select-sources'), false, 'no bulk toolbar in empty state');
});
