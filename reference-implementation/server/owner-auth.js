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
  renderHostedDocument,
  renderPageIntro,
} from './hosted-ui.js';

const COOKIE_NAME = 'pdpp_owner_session';
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours
const DEFAULT_SUBJECT_ID = 'owner_local';
const DEFAULT_RETURN_TO = '/consent';

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecodeToString(input) {
  return Buffer.from(String(input), 'base64url').toString('utf8');
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Encode a signed session token. The token is a base64url(JSON).base64url(hmac)
 * two-part string. We deliberately avoid a full JWT implementation here — this
 * is reference placeholder auth, not a product.
 */
function encodeSession(payload, secret) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = signPayload(body, secret);
  return `${body}.${sig}`;
}

function decodeSession(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.', 2);
  if (!body || !sig) return null;
  const expectedSig = signPayload(body, secret);
  if (!timingSafeEqualString(sig, expectedSig)) return null;
  let payload;
  try {
    payload = JSON.parse(base64UrlDecodeToString(body));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

/**
 * Derive a stable per-password signing secret. This keeps the signed cookie
 * tied to the current configured password — rotating the password
 * invalidates existing sessions, which is the behavior we want for a
 * placeholder.
 */
function deriveSecret(password) {
  return crypto.createHash('sha256').update(`pdpp-owner-session:${password}`).digest();
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https') {
    return true;
  }
  return false;
}

function buildSetCookie(value, { maxAgeSeconds, secure }) {
  const parts = [`${COOKIE_NAME}=${value}`];
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  parts.push('Path=/');
  if (secure) parts.push('Secure');
  if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

function clearCookieHeader({ secure }) {
  const parts = [`${COOKIE_NAME}=`];
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  parts.push('Path=/');
  if (secure) parts.push('Secure');
  parts.push('Max-Age=0');
  return parts.join('; ');
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
  sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
} = {}) {
  const enabled = typeof password === 'string' && password.length > 0;
  const resolvedSubjectId = (typeof subjectId === 'string' && subjectId) || DEFAULT_SUBJECT_ID;

  if (!enabled) {
    return {
      enabled: false,
      subjectId: resolvedSubjectId,
      attachRoutes() {},
      requireOwnerSession(_req, _res, next) {
        // Disabled: fall through to current open local-dev behavior.
        next();
      },
    };
  }

  const secret = deriveSecret(password);

  function readSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[COOKIE_NAME];
    if (!raw) return null;
    return decodeSession(raw, secret);
  }

  function issueSession(res, req) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: resolvedSubjectId,
      iat: now,
      exp: now + sessionTtlSeconds,
    };
    const token = encodeSession(payload, secret);
    res.setHeader(
      'Set-Cookie',
      buildSetCookie(token, {
        maxAgeSeconds: sessionTtlSeconds,
        secure: isSecureRequest(req),
      })
    );
  }

  function clearSession(res, req) {
    res.setHeader('Set-Cookie', clearCookieHeader({ secure: isSecureRequest(req) }));
  }

  function attachRoutes(app) {
    app.get('/owner/login', (req, res) => {
      const returnTo = sanitizeReturnTo(
        typeof req.query?.return_to === 'string' ? req.query.return_to : ''
      );
      // If already authenticated, skip the form entirely.
      if (readSession(req)) {
        return res.redirect(returnTo);
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(
        renderLoginPage({ providerName, error: null, returnTo })
      );
    });

    app.post('/owner/login', (req, res) => {
      const returnTo = sanitizeReturnTo(
        (req.body && typeof req.body.return_to === 'string' && req.body.return_to) ||
          (typeof req.query?.return_to === 'string' ? req.query.return_to : '')
      );
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
    enabled: true,
    subjectId: resolvedSubjectId,
    attachRoutes,
    requireOwnerSession,
  };
}

export const OWNER_AUTH_DEFAULT_SUBJECT_ID = DEFAULT_SUBJECT_ID;
export const OWNER_AUTH_COOKIE_NAME = COOKIE_NAME;
