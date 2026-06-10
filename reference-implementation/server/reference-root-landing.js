/**
 * Browser-friendly landing pages for the bare AS/RS reference roots.
 *
 * Spec: openspec/changes/split-public-site-and-operator-console
 *   - `reference-surface-topology` SHALL serve a content-negotiated HTML
 *     landing at the AS/RS root when the client wants HTML; JSON discovery
 *     remains byte-identical for JSON-shaped clients.
 *
 * This module is reference-only UI (hosted-ui style: plain strings + the
 * shared `hosted-ui` stylesheet). It is reachable from
 * `reference-implementation` alone and does NOT require `apps/console` to
 * be running.
 */

import {
  readHostedThemeChoiceFromCookieHeader,
  renderHostedDocument,
  renderKeyValueList,
  renderPageIntro,
  renderSurface,
} from './hosted-ui.js';
import {
  DEFAULT_REFERENCE_BROWSER_ORIGIN,
  resolveReferenceBrowserOrigin,
} from './reference-topology.ts';

/**
 * Resolve the operator console origin to advertise on the landing page.
 *
 * Order of preference:
 *   1. explicit `consoleOrigin` argument (used by tests),
 *   2. `PDPP_REFERENCE_ORIGIN` env var (the documented composed-mode hint),
 *   3. the bare-default `http://localhost:3002` so a developer hitting the
 *      port directly always sees a working link.
 */
export function resolveConsoleOriginForLanding({ consoleOrigin, env = process.env } = {}) {
  return resolveReferenceBrowserOrigin({
    explicitOrigin: consoleOrigin ?? null,
    env,
  }) || DEFAULT_REFERENCE_BROWSER_ORIGIN;
}

function renderRootLanding({
  role,
  providerName,
  referenceRevision,
  consoleOrigin,
  themeChoice = 'system',
}) {
  const isAs = role === 'authorization_server';
  const roleLabel = isAs ? 'Authorization Server' : 'Resource Server';
  const wellKnownPath = isAs
    ? '/.well-known/oauth-authorization-server'
    : '/.well-known/oauth-protected-resource';
  const wellKnownLabel = isAs
    ? 'oauth-authorization-server'
    : 'oauth-protected-resource';

  const intro = renderPageIntro({
    eyebrow: `PDPP reference · ${roleLabel}`,
    title: providerName,
    lede:
      'You are looking at the bare reference server. Operator UIs live on the console origin below; ' +
      'discovery JSON is available at the well-known endpoints.',
  });

  const facts = renderSurface({
    surface: 'protocol',
    ariaLabel: 'Reference facts',
    children: renderKeyValueList([
      { key: 'Role', value: roleLabel },
      { key: 'Provider', value: providerName },
      { key: 'Reference revision', value: referenceRevision },
      {
        key: 'Discovery JSON',
        value: `<code><a href="${wellKnownPath}">${wellKnownLabel}</a></code>`,
      },
      {
        key: 'Operator console',
        value: `<code><a href="${consoleOrigin}/dashboard">${consoleOrigin}/dashboard</a></code>`,
      },
    ]),
  });

  const guidance = renderSurface({
    ariaLabel: 'Next steps',
    children: `
      <p class="pdpp-body">
        JSON clients receive the discovery index unchanged — re-request this URL with
        <code>Accept: application/json</code>.
      </p>
      <p class="pdpp-body">
        Browsers should use the operator console for run, schedule, grant, and connector surfaces.
        The console origin shown above is taken from <code>PDPP_REFERENCE_ORIGIN</code>; override it
        per deployment if your console lives elsewhere.
      </p>
    `,
  });

  return renderHostedDocument({
    title: `${providerName} · PDPP ${roleLabel}`,
    providerName,
    themeChoice,
    body: `${intro}\n${facts}\n${guidance}`,
  });
}

/**
 * Express-style negotiation: serve HTML to browsers, fall through to JSON
 * for JSON-shaped clients (existing discovery contract).
 *
 * Caller pattern:
 *   if (servedRootLandingIfBrowser(req, res, {...})) return;
 *   res.json(executeAsDiscoveryIndex(...));
 *
 * Negotiation rules:
 *   - explicit `?format=json` → JSON path (caller proceeds).
 *   - `Accept` containing `application/json` → JSON path.
 *   - Otherwise, if the client explicitly prefers HTML (`Accept: text/html`),
 *     render the landing page and return true.
 *   - No Accept header or `Accept: *\/*` → JSON (preserves the existing
 *     default for tooling and curl-like probes).
 */
export function servedRootLandingIfBrowser(req, res, options) {
  const role = options.role;
  const providerName = options.providerName;
  const referenceRevision = options.referenceRevision;

  if (req.query && req.query.format === 'json') {
    return false;
  }

  // `req.accepts` is added by Express. When the client explicitly asks for
  // JSON (or sends no Accept header), keep the existing JSON contract.
  const accept = req.headers?.accept;
  if (typeof accept !== 'string' || accept.length === 0) {
    return false;
  }
  if (accept === '*/*') {
    return false;
  }

  // `req.accepts(['html', 'json'])` returns the best match the client
  // declared. We only want to switch to HTML when the client prefers it.
  let best = null;
  if (typeof req.accepts === 'function') {
    best = req.accepts(['html', 'json']);
  } else {
    // Conservative fallback when running outside Express.
    if (/\btext\/html\b/.test(accept)) {
      best = 'html';
    } else if (/\bapplication\/json\b/.test(accept)) {
      best = 'json';
    }
  }
  if (best !== 'html') {
    return false;
  }

  const consoleOrigin = resolveConsoleOriginForLanding({
    consoleOrigin: options.consoleOrigin,
    env: options.env,
  });
  const themeChoice = readHostedThemeChoiceFromCookieHeader(req.headers?.cookie);
  const html = renderRootLanding({
    role,
    providerName,
    referenceRevision,
    consoleOrigin,
    themeChoice,
  });

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.send(html);
  return true;
}

export const __testOnly = {
  renderRootLanding,
};
