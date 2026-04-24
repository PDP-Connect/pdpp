/**
 * Reference-only owner-auth placeholder.
 *
 * This module adds a minimal local-only session gate in front of the
 * reference approval UIs (`/consent*`, `/device*`). It is intentionally
 * narrow:
 *
 *   - enabled only when `PDPP_OWNER_PASSWORD` is set
 *   - single-password, single-owner model
 *   - no user table, no external IdP, no password reset
 *   - stateless signed cookie (HMAC-SHA256) — no DB-backed sessions
 *
 * It is NOT a PDPP protocol surface. It is NOT a full owner-authentication
 * product. See
 * `openspec/changes/reference-implementation-program/design-notes/owner-auth-placeholder-open-question-2026-04-22.md`
 * for scope and rationale.
 */
import crypto from 'node:crypto';
import {
  escapeHtml as hostedEscape,
  renderActionRow,
  renderHostedDocument,
  renderKeyValueList,
  renderPageIntro,
  renderResultState,
  renderSurface,
} from './hosted-ui.js';
import {
  createOwnerSessionController,
  OWNER_SESSION_COOKIE_NAME,
  OWNER_SESSION_DEFAULT_SUBJECT_ID,
  OWNER_SESSION_DEFAULT_TTL_SECONDS,
} from './owner-session.ts';

const DEFAULT_RETURN_TO = '/owner/login';

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https') {
    return true;
  }
  return false;
}

function wantsHtml(req) {
  const accept = req.headers.accept;
  if (typeof accept !== 'string') return false;
  // Accept headers from browsers always include text/html; API clients
  // typically send application/json or */* without text/html.
  return accept.includes('text/html');
}

function renderLoginPage({ providerName, error, returnTo }) {
  const safeReturnTo = typeof returnTo === 'string' ? returnTo : '';
  const errorBlock = error
    ? `<div class="hosted-ui-error" role="alert">${hostedEscape(error)}</div>`
    : '';
  const form = `<form class="hosted-ui-surface" method="POST" action="/owner/login" data-surface="human" aria-label="Owner sign-in">
  <input type="hidden" name="return_to" value="${hostedEscape(safeReturnTo)}" />
  ${errorBlock}
  <div class="hosted-ui-field">
    <label for="hosted-ui-password">Owner password</label>
    <input id="hosted-ui-password" type="password" name="password" autofocus autocomplete="current-password" required />
  </div>
  <div class="hosted-ui-actions">
    <button type="submit" class="hosted-ui-button" data-variant="primary">Sign in</button>
  </div>
  <p class="hosted-ui-footnote">Configured via <code>PDPP_OWNER_PASSWORD</code>. Clear this placeholder with <code>POST /owner/logout</code>.</p>
</form>`;

  const body = [
    renderPageIntro({
      eyebrow: 'Owner sign-in',
      title: `Sign in to ${providerName}`,
      lede: 'This is the local placeholder owner auth for the reference implementation. It is not a full auth product.',
    }),
    form,
  ].join('\n');

  return renderHostedDocument({
    title: `${providerName} — Owner sign-in`,
    providerName,
    body,
  });
}

function renderOwnerAuthDisabledPage({ providerName }) {
  const body = [
    renderPageIntro({
      eyebrow: 'Owner approval UI',
      title: `${providerName} owner access`,
      lede: 'Placeholder owner sign-in is disabled on this local reference instance, so approval pages remain open in local-dev mode.',
    }),
    renderSurface({
      surface: 'human',
      ariaLabel: 'Owner auth status',
      children: renderResultState({
        tone: 'neutral',
        title: 'Sign-in is not required right now',
        body: 'Device approvals are open locally. Consent approvals still arrive through pending request links.',
        footnote: 'Set PDPP_OWNER_PASSWORD to turn on the reference-only session gate.',
      }),
    }),
    renderSurface({
      surface: 'protocol',
      ariaLabel: 'Owner auth configuration details',
      children: renderKeyValueList([
        { label: 'Current mode', value: 'Open local-dev approval UI' },
        { label: 'Enable sign-in', html: '<code>PDPP_OWNER_PASSWORD=&lt;password&gt;</code>' },
        { label: 'Protected when enabled', value: '/consent*, /device*, /owner/login' },
        { label: 'Consent pages', value: 'Reached from a pending request authorization_url / request_uri flow' },
      ]),
    }),
    renderActionRow([
      { href: '/device', label: 'Open device approval UI', variant: 'primary' },
    ]),
  ].join('\n');

  return renderHostedDocument({
    title: `${providerName} — Owner access`,
    providerName,
    body,
  });
}

function renderSignedInOwnerPage({ providerName, subjectId }) {
  const body = [
    renderPageIntro({
      eyebrow: 'Owner approval UI',
      title: `${providerName} owner access`,
      lede: 'You are signed in to the local placeholder owner-auth gate for the reference implementation.',
    }),
    renderSurface({
      surface: 'human',
      ariaLabel: 'Signed-in owner state',
      children: [
        renderResultState({
          tone: 'success',
          title: 'Signed in',
          body: 'You can approve device flows directly here, or open a pending consent URL from a staged provider-connect request.',
          footnote: 'This session is reference-only placeholder auth, not a full owner account system.',
        }),
        renderKeyValueList([
          { label: 'Owner subject', html: `<code>${hostedEscape(subjectId)}</code>` },
        ]),
      ].join('\n'),
    }),
    renderActionRow([
      { href: '/device', label: 'Open device approval UI', variant: 'primary' },
      { action: '/owner/logout', label: 'Sign out' },
    ]),
  ].join('\n');

  return renderHostedDocument({
    title: `${providerName} — Owner access`,
    providerName,
    body,
  });
}

/**
 * Normalize a `return_to` form/query parameter to a same-origin path. We
 * reject anything that looks like an absolute URL or protocol-relative URL
 * so the placeholder cannot be abused as an open redirect.
 */
function sanitizeReturnTo(input) {
  if (typeof input !== 'string' || !input) return DEFAULT_RETURN_TO;
  // Must start with a single '/' and not '//' (protocol-relative) and not contain \\
  if (!input.startsWith('/')) return DEFAULT_RETURN_TO;
  if (input.startsWith('//')) return DEFAULT_RETURN_TO;
  if (input.includes('\\')) return DEFAULT_RETURN_TO;
  if (/[\u0000-\u001F\u007F]/.test(input)) return DEFAULT_RETURN_TO;
  return input;
}

function deriveRequestOrigin(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  if (!host) return null;
  return `${isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}

function deriveReturnToFromRequest(req) {
  const originalUrl = sanitizeReturnTo(req.originalUrl || req.url || DEFAULT_RETURN_TO);
  if (req.method === 'GET' || req.method === 'HEAD') {
    return originalUrl;
  }

  const referrer =
    typeof req.headers.referer === 'string'
      ? req.headers.referer
      : (typeof req.headers.referrer === 'string' ? req.headers.referrer : '');
  if (!referrer) return originalUrl;

  try {
    const referrerUrl = new URL(referrer);
    const currentOrigin = deriveRequestOrigin(req);
    if (!currentOrigin || referrerUrl.origin !== currentOrigin) {
      return originalUrl;
    }
    return sanitizeReturnTo(
      `${referrerUrl.pathname || '/'}${referrerUrl.search || ''}${referrerUrl.hash || ''}`
    );
  } catch {
    return originalUrl;
  }
}

/**
 * Build the owner-auth placeholder. Returns an object with:
 *   - `enabled`: whether placeholder auth is active (password configured)
 *   - `subjectId`: the single owner subject id to use when enabled
 *   - `attachRoutes(app)`: wire `/owner/login*` and `/owner/logout` routes
 *   - `requireOwnerSession(req, res, next)`: Express middleware that gates
 *     a protected route. Redirects browsers to `/owner/login`, returns 401
 *     JSON to non-HTML callers.
 */
export function createOwnerAuthPlaceholder({
  password,
  subjectId,
  providerName = 'PDPP Reference Provider',
  sessionTtlSeconds = OWNER_SESSION_DEFAULT_TTL_SECONDS,
} = {}) {
  const sessionController = createOwnerSessionController({
    password,
    subjectId,
    sessionTtlSeconds,
  });
  const { enabled, subjectId: resolvedSubjectId } = sessionController;

  function issueSession(res, req) {
    const cookieHeader = sessionController.issueSessionCookieHeader({
      secure: isSecureRequest(req),
    });
    if (cookieHeader) {
      res.setHeader('Set-Cookie', cookieHeader);
    }
  }

  function clearSession(res, req) {
    res.setHeader(
      'Set-Cookie',
      sessionController.clearSessionCookieHeader({ secure: isSecureRequest(req) })
    );
  }

  function readSession(req) {
    return sessionController.readSessionFromCookieHeader(req.headers.cookie);
  }

  function attachRoutes(app) {
    app.get('/owner/login', (req, res) => {
      const hasExplicitReturnTo = typeof req.query?.return_to === 'string' && req.query.return_to.length > 0;
      const returnTo = sanitizeReturnTo(
        typeof req.query?.return_to === 'string' ? req.query.return_to : ''
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');

      if (!enabled) {
        return res.status(200).send(renderOwnerAuthDisabledPage({ providerName }));
      }

      const session = readSession(req);
      if (session) {
        if (hasExplicitReturnTo) {
          return res.redirect(returnTo);
        }
        return res.status(200).send(
          renderSignedInOwnerPage({ providerName, subjectId: resolvedSubjectId })
        );
      }

      return res.status(200).send(
        renderLoginPage({ providerName, error: null, returnTo })
      );
    });

    app.post('/owner/login', (req, res) => {
      const returnTo = sanitizeReturnTo(
        (req.body && typeof req.body.return_to === 'string' && req.body.return_to) ||
          (typeof req.query?.return_to === 'string' ? req.query.return_to : '')
      );

      if (!enabled) {
        if (wantsHtml(req)) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.status(400).send(renderOwnerAuthDisabledPage({ providerName }));
        }
        return res
          .status(400)
          .setHeader('Content-Type', 'application/json')
          .json({
            error: {
              type: 'invalid_request',
              code: 'owner_auth_disabled',
              message: 'Owner placeholder auth is disabled on this reference instance.',
            },
          });
      }

      const submitted =
        req.body && typeof req.body.password === 'string' ? req.body.password : '';
      if (!submitted || !timingSafeEqualString(submitted, password)) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(401).send(
          renderLoginPage({
            providerName,
            error: 'Incorrect password.',
            returnTo,
          })
        );
        return;
      }
      issueSession(res, req);
      res.redirect(returnTo);
    });

    app.post('/owner/logout', (req, res) => {
      clearSession(res, req);
      if (wantsHtml(req)) {
        return res.redirect('/owner/login');
      }
      res.status(204).end();
    });
  }

  function requireOwnerSession(req, res, next) {
    if (!enabled) {
      // Disabled: fall through to current open local-dev behavior.
      return next();
    }

    const session = readSession(req);
    if (session) {
      req.ownerSession = session;
      return next();
    }

    if (wantsHtml(req)) {
      const returnTo = encodeURIComponent(deriveReturnToFromRequest(req));
      return res.redirect(`/owner/login?return_to=${returnTo}`);
    }
    res
      .status(401)
      .setHeader('Content-Type', 'application/json')
      .json({
        error: {
          type: 'authentication_error',
          code: 'owner_session_required',
          message:
            'Owner session required. This is the reference implementation placeholder owner auth; sign in at /owner/login.',
        },
      });
  }

  return {
    enabled,
    subjectId: resolvedSubjectId,
    attachRoutes,
    requireOwnerSession,
  };
}

export const OWNER_AUTH_DEFAULT_SUBJECT_ID = OWNER_SESSION_DEFAULT_SUBJECT_ID;
export const OWNER_AUTH_COOKIE_NAME = OWNER_SESSION_COOKIE_NAME;
