/**
 * Hosted-UI layer for the reference server.
 *
 * Small, boring, server-rendered UI helpers shared by every hosted HTML
 * page (`/consent`, `/device`, consent/device result pages, `/owner/login`).
 * These pages are reference-only surfaces, not PDPP protocol surfaces.
 *
 * Design intent:
 *   - reuse the PDPP brand language (tokens, typography classes, semantic
 *     surfaces) from `packages/pdpp-brand/base.css`
 *   - no framework, no hydration — plain strings and one stylesheet
 *   - do not fork the design system for hosted pages; keep the hosted-ui
 *     layer minimal and clearly prefixed (`hosted-ui-*`)
 *
 * Shared stylesheet is served by the AS app at `/__pdpp/hosted-ui.css`
 * (see `HOSTED_UI_CSS_PATH` and `HOSTED_UI_CSS`).
 */

export const HOSTED_UI_CSS_PATH = '/__pdpp/hosted-ui.css';
export const HOSTED_UI_BRAND_MARKER = 'data-pdpp-hosted-ui';
export const HOSTED_UI_THEME_COOKIE_NAME = 'pdpp-theme';

export function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── PDPP mark (server-side SVG) ─────────────────────────────────────────────
// Geometry mirrors apps/web/src/components/PdppLogo.tsx so the reference
// pages carry the same mark as the website. Keep in sync.

const HUMAN = 'oklch(0.52 0.11 45)';
const PROTOCOL = 'oklch(0.58 0.18 253)';
const COUNTER = 'oklch(0.985 0.005 85)';

export function renderPdppMark({ size = 28, title = 'PDPP' } = {}) {
  const safeTitle = escapeHtml(title);
  const labelAttr = title ? `role="img" aria-label="${safeTitle}"` : 'role="presentation" aria-hidden="true"';
  return `<svg class="hosted-ui-mark" viewBox="0 0 200 200" width="${size}" height="${size}" ${labelAttr}>` +
    `<path d="M 40 30 L 40 170 L 60 170 L 60 116 L 100 116 Q 105 116 105 110 L 105 30 Z" fill="${HUMAN}"/>` +
    `<path d="M 105 30 L 105 110 Q 105 116 100 116 L 60 116 L 60 170 L 80 170 L 80 136 L 125 136 Q 155 136 155 103 Q 155 30 105 30 Z" fill="${PROTOCOL}"/>` +
    `<circle cx="105" cy="73" r="18" fill="${COUNTER}"/>` +
    `</svg>`;
}

// ─── Shared CSS ──────────────────────────────────────────────────────────────
// Minimal PDPP subset derived from packages/pdpp-brand/base.css plus a tiny
// hosted-ui layer. No fontsource imports — these pages fall back to system UI
// until font weights load from the website. Reference-only by design.

export const HOSTED_UI_CSS = `:root {
  --font-sans: "Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --background: oklch(0.99 0.002 95);
  --foreground: oklch(0.13 0 0);
  --card: oklch(1 0 0);
  --primary: oklch(0.580 0.172 253.7);
  --primary-foreground: oklch(0.99 0 0);
  --muted: oklch(0.96 0 0);
  --muted-foreground: oklch(0.50 0 0);
  --destructive: oklch(0.55 0.20 27);
  --destructive-foreground: oklch(0.99 0 0);
  --border: oklch(0.94 0 0);
  --input: oklch(0.91 0 0);
  --success: oklch(0.52 0.15 150);
  --warning: oklch(0.62 0.15 70);
  --human: oklch(0.52 0.09 45);
  --human-wash: oklch(0.52 0.09 45 / 0.07);
  --radius: 0.5rem;
  color-scheme: light;
}

html[data-theme="dark"] {
  --background: oklch(0.16 0.005 260);
  --foreground: oklch(0.985 0.004 85);
  --card: oklch(0.205 0.006 260);
  --primary: oklch(0.68 0.15 253.7);
  --primary-foreground: oklch(0.11 0.008 260);
  --muted: oklch(0.25 0.007 260);
  --muted-foreground: oklch(0.72 0.01 260);
  --destructive: oklch(0.70 0.18 27);
  --destructive-foreground: oklch(0.11 0.008 260);
  --border: oklch(1 0 0 / 0.12);
  --input: oklch(1 0 0 / 0.18);
  --success: oklch(0.70 0.14 150);
  --warning: oklch(0.78 0.13 78);
  --human: oklch(0.68 0.10 45);
  --human-wash: oklch(0.68 0.10 45 / 0.14);
  color-scheme: dark;
}

@media (prefers-color-scheme: dark) {
  html[data-theme="system"] {
    --background: oklch(0.16 0.005 260);
    --foreground: oklch(0.985 0.004 85);
    --card: oklch(0.205 0.006 260);
    --primary: oklch(0.68 0.15 253.7);
    --primary-foreground: oklch(0.11 0.008 260);
    --muted: oklch(0.25 0.007 260);
    --muted-foreground: oklch(0.72 0.01 260);
    --destructive: oklch(0.70 0.18 27);
    --destructive-foreground: oklch(0.11 0.008 260);
    --border: oklch(1 0 0 / 0.12);
    --input: oklch(1 0 0 / 0.18);
    --success: oklch(0.70 0.14 150);
    --warning: oklch(0.78 0.13 78);
    --human: oklch(0.68 0.10 45);
    --human-wash: oklch(0.68 0.10 45 / 0.14);
    color-scheme: dark;
  }
}

*, *::before, *::after { box-sizing: border-box; }

html {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at top left, oklch(0.52 0.09 45 / 0.06), transparent 28rem),
    linear-gradient(180deg, oklch(1 0 0) 0%, var(--background) 14rem);
  color: var(--foreground);
  font-family: var(--font-sans);
}

html[data-theme="dark"] body {
  background:
    radial-gradient(circle at top left, oklch(0.68 0.10 45 / 0.12), transparent 28rem),
    linear-gradient(180deg, oklch(0.22 0.006 260) 0%, var(--background) 14rem);
}

@media (prefers-color-scheme: dark) {
  html[data-theme="system"] body {
    background:
      radial-gradient(circle at top left, oklch(0.68 0.10 45 / 0.12), transparent 28rem),
      linear-gradient(180deg, oklch(0.22 0.006 260) 0%, var(--background) 14rem);
  }
}

a { color: inherit; }
code, pre, kbd, samp { font-family: var(--font-mono); }

/* ─── PDPP type scale (subset) ──────────────────────────────────────── */
.pdpp-display {
  font-size: 2.5rem; font-weight: 600; line-height: 1.08; letter-spacing: -0.025em;
}
.pdpp-heading {
  font-size: 1.25rem; font-weight: 600; line-height: 1.3; letter-spacing: -0.01em;
}
.pdpp-title {
  font-size: 0.875rem; font-weight: 600; line-height: 1.4;
}
.pdpp-body-lg {
  font-size: 1.0625rem; font-weight: 400; line-height: 1.6;
}
.pdpp-body {
  font-size: 0.9375rem; font-weight: 400; line-height: 1.6;
}
.pdpp-label {
  font-size: 0.75rem; font-weight: 500; line-height: 1.4;
}
.pdpp-caption {
  font-size: 0.75rem; font-weight: 400; line-height: 1.5;
  color: var(--muted-foreground);
}
.pdpp-eyebrow {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}

/* ─── Semantic surfaces (match base.css) ────────────────────────────── */
[data-surface="human"] {
  border-top: 1px solid var(--border);
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  border-left: 2px solid var(--human);
  background-image: linear-gradient(to bottom, var(--human-wash), transparent 35%);
  background-color: var(--card);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 1px 3px rgb(0 0 0 / 0.02);
  border-radius: 0.75rem;
}

[data-surface="protocol"] {
  border-top: 1px solid var(--border);
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  border-left: 2px solid var(--primary);
  background-image: linear-gradient(to right, oklch(0.580 0.172 253.7 / 0.04), transparent 70%);
  background-color: var(--card);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 1px 3px rgb(0 0 0 / 0.02);
  border-radius: 0.75rem;
}

/* ─── Hosted-ui layout ──────────────────────────────────────────────── */
.hosted-ui-page {
  max-width: 640px;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.hosted-ui-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding-bottom: 0.25rem;
}

.hosted-ui-wordmark {
  font-weight: 600;
  font-size: 0.9375rem;
  letter-spacing: -0.01em;
  color: var(--foreground);
}

.hosted-ui-provider {
  margin-left: auto;
  font-size: 0.8125rem;
  color: var(--muted-foreground);
}

.hosted-ui-mark { display: block; }

.hosted-ui-intro {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.hosted-ui-intro .pdpp-body-lg {
  color: var(--muted-foreground);
  max-width: 50ch;
}

.hosted-ui-surface {
  padding: 1.25rem 1.25rem 1.125rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.hosted-ui-surface > * + * { margin-top: 0; }

.hosted-ui-kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.375rem 1rem;
  margin: 0;
  padding: 0;
}
.hosted-ui-kv dt {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--muted-foreground);
}
.hosted-ui-kv dd {
  font-size: 0.875rem;
  margin: 0;
  color: var(--foreground);
  word-break: break-word;
}
.hosted-ui-kv code {
  font-size: 0.8125rem;
  color: var(--foreground);
}

.hosted-ui-streams {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.hosted-ui-streams li {
  border: 1px solid var(--border);
  background: var(--card);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
}
.hosted-ui-streams .hosted-ui-stream-name {
  font-family: var(--font-mono);
  font-weight: 500;
  color: var(--foreground);
}
.hosted-ui-streams .hosted-ui-stream-meta {
  color: var(--muted-foreground);
  margin-left: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
}

.hosted-ui-actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  align-items: center;
}

.hosted-ui-button {
  appearance: none;
  border-radius: 0.5rem;
  padding: 0.625rem 1.125rem;
  font-size: 0.9375rem;
  font-weight: 500;
  line-height: 1.2;
  font-family: inherit;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--foreground);
  transition: background-color 150ms, border-color 150ms;
}
.hosted-ui-button:hover { background: var(--muted); }
.hosted-ui-button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.hosted-ui-button[data-variant="primary"] {
  background: var(--primary);
  color: var(--primary-foreground);
  border-color: transparent;
}
.hosted-ui-button[data-variant="primary"]:hover {
  background: oklch(0.52 0.172 253.7);
}
.hosted-ui-button[data-variant="danger"] {
  color: var(--destructive);
  border-color: var(--border);
}
.hosted-ui-button[data-variant="danger"]:hover {
  background: oklch(0.55 0.20 27 / 0.08);
}

.hosted-ui-form { display: contents; }

.hosted-ui-field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.hosted-ui-field label {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--muted-foreground);
}
.hosted-ui-field input {
  font: inherit;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--input);
  border-radius: 0.5rem;
  background: var(--card);
  color: var(--foreground);
}
.hosted-ui-field input:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
  border-color: var(--primary);
}

.hosted-ui-code {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: 0.25em;
  color: var(--primary);
}

.hosted-ui-error {
  border: 1px solid oklch(0.55 0.20 27 / 0.25);
  background: oklch(0.55 0.20 27 / 0.06);
  color: var(--destructive);
  padding: 0.625rem 0.875rem;
  border-radius: 0.5rem;
  font-size: 0.875rem;
}

.hosted-ui-warning {
  border: 1px solid oklch(0.78 0.16 78 / 0.45);
  background: oklch(0.78 0.16 78 / 0.08);
  color: var(--foreground);
  padding: 0.75rem 0.875rem;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.hosted-ui-warning-title {
  font-weight: 600;
  font-size: 0.8125rem;
  letter-spacing: 0.025em;
  text-transform: uppercase;
  color: oklch(0.45 0.12 60);
}
.hosted-ui-warning-body {
  color: var(--foreground);
}

.hosted-ui-result {
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
}
.hosted-ui-result-mark {
  width: 2rem;
  height: 2rem;
  border-radius: 9999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.875rem;
  font-weight: 600;
  flex-shrink: 0;
}
.hosted-ui-result-mark[data-tone="success"] {
  background: oklch(0.52 0.15 150 / 0.14);
  color: var(--success);
}
.hosted-ui-result-mark[data-tone="neutral"] {
  background: var(--muted);
  color: var(--muted-foreground);
}
.hosted-ui-result-mark[data-tone="danger"] {
  background: oklch(0.55 0.20 27 / 0.12);
  color: var(--destructive);
}
.hosted-ui-result-body {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.hosted-ui-footnote {
  color: var(--muted-foreground);
  font-size: 0.75rem;
  margin-top: 0.5rem;
}
`;

// ─── Render helpers ──────────────────────────────────────────────────────────

/**
 * Render a complete hosted HTML document. All hosted reference pages go
 * through this so they share head, CSS, and brand header.
 */
export function normalizeHostedThemeChoice(value) {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function readHostedThemeChoiceFromCookieHeader(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) {
    return 'system';
  }
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name !== HOSTED_UI_THEME_COOKIE_NAME) {
      continue;
    }
    const raw = part.slice(eq + 1).trim();
    try {
      return normalizeHostedThemeChoice(decodeURIComponent(raw));
    } catch {
      return normalizeHostedThemeChoice(raw);
    }
  }
  return 'system';
}

export function renderHostedDocument({ title, providerName, body, themeChoice = 'system' }) {
  const safeTitle = escapeHtml(title);
  const safeThemeChoice = normalizeHostedThemeChoice(themeChoice);
  return `<!DOCTYPE html>
<html lang="en" data-theme="${safeThemeChoice}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${safeTitle}</title>
<link rel="stylesheet" href="${HOSTED_UI_CSS_PATH}" />
</head>
<body ${HOSTED_UI_BRAND_MARKER}>
<main class="hosted-ui-page" aria-labelledby="hosted-ui-page-title">
${renderBrandHeader({ providerName })}
${body}
</main>
</body>
</html>`;
}

/**
 * Brand header: PDPP mark + wordmark + provider name.
 */
export function renderBrandHeader({ providerName }) {
  const safeProvider = escapeHtml(providerName);
  return `<header class="hosted-ui-header">
  ${renderPdppMark({ size: 28 })}
  <span class="hosted-ui-wordmark">PDPP</span>
  <span class="hosted-ui-provider" aria-label="Provider">${safeProvider}</span>
</header>`;
}

/**
 * Eyebrow + heading + optional lede. The heading gets id="hosted-ui-page-title"
 * so the <main> labelled-by reference lands on something real.
 */
export function renderPageIntro({ eyebrow, title, lede } = {}) {
  const parts = [];
  if (eyebrow) parts.push(`<span class="pdpp-eyebrow">${escapeHtml(eyebrow)}</span>`);
  parts.push(`<h1 id="hosted-ui-page-title" class="pdpp-display">${escapeHtml(title ?? '')}</h1>`);
  if (lede) parts.push(`<p class="pdpp-body-lg">${escapeHtml(lede)}</p>`);
  return `<section class="hosted-ui-intro">${parts.join('\n')}</section>`;
}

/**
 * A semantic surface block. Use sparingly — `human` for owner/consent
 * artifacts, `protocol` for technical blocks that are genuinely protocol
 * facts, `undefined` for neutral containers.
 */
export function renderSurface({ surface, children, ariaLabel } = {}) {
  const attr = surface ? ` data-surface="${escapeHtml(surface)}"` : '';
  const label = ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : '';
  return `<section class="hosted-ui-surface"${attr}${label}>${children}</section>`;
}

/**
 * Render a <dl> of key/value facts. Values may contain markup; keys are
 * always escaped.
 */
export function renderKeyValueList(items) {
  const rows = items
    .filter((item) => {
      if (!item) return false;
      if (item.html) return true;
      return item.value !== null && item.value !== undefined && item.value !== '';
    })
    .map((item) => {
      const dt = `<dt>${escapeHtml(item.label)}</dt>`;
      const value = item.html ? item.html : escapeHtml(String(item.value));
      const dd = `<dd>${value}</dd>`;
      return `${dt}${dd}`;
    })
    .join('');
  return `<dl class="hosted-ui-kv">${rows}</dl>`;
}

/**
 * Render a row of buttons / form submissions. Each action may specify
 * `form` (inline form with hidden fields, method and action) or `href`
 * (link styled as button).
 */
export function renderActionRow(actions) {
  const parts = actions.map((action) => {
    if (action.href) {
      return `<a class="hosted-ui-button" data-variant="${escapeHtml(action.variant || 'default')}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`;
    }
    const method = escapeHtml(action.method || 'POST');
    const actionUrl = escapeHtml(action.action || '');
    const hidden = (action.hidden || [])
      .map((f) => `<input type="hidden" name="${escapeHtml(f.name)}" value="${escapeHtml(f.value ?? '')}" />`)
      .join('');
    return `<form class="hosted-ui-form" method="${method}" action="${actionUrl}">${hidden}<button type="submit" class="hosted-ui-button" data-variant="${escapeHtml(action.variant || 'default')}">${escapeHtml(action.label)}</button></form>`;
  });
  return `<div class="hosted-ui-actions">${parts.join('')}</div>`;
}

/**
 * Result state — approved / denied / invalid. `tone` is success | neutral | danger.
 */
export function renderResultState({ tone = 'neutral', glyph, title, body, footnote } = {}) {
  const defaultGlyph = { success: '✓', danger: '×', neutral: '•' }[tone] || '•';
  const safeGlyph = escapeHtml(glyph ?? defaultGlyph);
  const safeTone = escapeHtml(tone);
  const safeTitle = escapeHtml(title ?? '');
  const safeBody = body ? `<p class="pdpp-body">${escapeHtml(body)}</p>` : '';
  const safeFoot = footnote ? `<p class="hosted-ui-footnote">${escapeHtml(footnote)}</p>` : '';
  return `<div class="hosted-ui-result">
  <span class="hosted-ui-result-mark" data-tone="${safeTone}" aria-hidden="true">${safeGlyph}</span>
  <div class="hosted-ui-result-body">
    <span class="pdpp-heading">${safeTitle}</span>
    ${safeBody}
    ${safeFoot}
  </div>
</div>`;
}

/**
 * Generic empty / enter-code state for forms like `/device` without a code.
 * `form` is an object { action, method, fields: [{ name, label, value, autofocus, type }], submitLabel }.
 */
export function renderEmptyState({ title, body, form } = {}) {
  const fields = (form?.fields || [])
    .map((f) => {
      const inputType = escapeHtml(f.type || 'text');
      const autofocus = f.autofocus ? ' autofocus' : '';
      const autocomplete = f.autocomplete ? ` autocomplete="${escapeHtml(f.autocomplete)}"` : '';
      const safeName = escapeHtml(f.name);
      const safeLabel = escapeHtml(f.label);
      const safeValue = escapeHtml(f.value ?? '');
      return `<div class="hosted-ui-field">
  <label for="hosted-ui-${safeName}">${safeLabel}</label>
  <input id="hosted-ui-${safeName}" name="${safeName}" value="${safeValue}" type="${inputType}"${autofocus}${autocomplete} />
</div>`;
    })
    .join('');

  const submitLabel = escapeHtml(form?.submitLabel || 'Continue');
  const method = escapeHtml(form?.method || 'GET');
  const action = escapeHtml(form?.action || '');
  const hidden = (form?.hidden || [])
    .map((f) => `<input type="hidden" name="${escapeHtml(f.name)}" value="${escapeHtml(f.value ?? '')}" />`)
    .join('');

  const bodyText = body ? `<p class="pdpp-body">${escapeHtml(body)}</p>` : '';
  const titleText = title ? `<h2 class="pdpp-heading">${escapeHtml(title)}</h2>` : '';

  return `<form class="hosted-ui-surface" method="${method}" action="${action}">
  ${titleText}
  ${bodyText}
  ${hidden}
  ${fields}
  <div class="hosted-ui-actions">
    <button type="submit" class="hosted-ui-button" data-variant="primary">${submitLabel}</button>
  </div>
</form>`;
}
