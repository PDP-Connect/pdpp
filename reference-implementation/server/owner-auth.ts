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
import crypto from "node:crypto";
import {
  escapeHtml as hostedEscape,
  readHostedThemeChoiceFromCookieHeader,
  renderActionRow,
  renderHostedDocument,
  renderKeyValueList,
  renderPageIntro,
  renderResultState,
  renderSurface,
} from "./hosted-ui.js";
import {
  buildOwnerCsrfClearCookie,
  buildOwnerCsrfSetCookie,
  generateOwnerCsrfSecret,
  issueOwnerCsrfToken,
  OWNER_CSRF_COOKIE_NAME,
  OWNER_CSRF_FIELD_NAME,
  type OwnerCsrfSecret,
  readCsrfTokenFromCookieHeader,
  renderCsrfHiddenField,
  validateOwnerCsrfPair,
  verifyOwnerCsrfToken,
} from "./owner-csrf.ts";
import {
  createOwnerSessionController,
  OWNER_SESSION_COOKIE_NAME,
  OWNER_SESSION_DEFAULT_SUBJECT_ID,
  OWNER_SESSION_DEFAULT_TTL_SECONDS,
  type OwnerSessionController,
  type OwnerSessionPayload,
  type OwnerSessionSameSite,
} from "./owner-session.ts";

const DEFAULT_RETURN_TO = "/owner/login";

// Minimal structural interfaces for the Express request/response surface
// actually used inside this module. We don't import express's type tree
// because this module is also driven by tests that fabricate a tiny
// request shim — keeping the contract local keeps the coupling honest.

interface AuthRequestHeaders {
  readonly accept?: string;
  readonly cookie?: string;
  readonly host?: string;
  readonly referer?: string;
  readonly referrer?: string;
  readonly "x-forwarded-proto"?: string;
}

interface AuthRequest {
  readonly body?: Record<string, unknown>;
  readonly headers: AuthRequestHeaders;
  readonly method?: string;
  readonly originalUrl?: string;
  ownerSession?: OwnerSessionPayload;
  readonly query?: Record<string, unknown>;
  readonly secure?: boolean;
  readonly url?: string;
}

interface AuthResponse {
  end(): void;
  getHeader?(name: string): unknown;
  json(body: unknown): AuthResponse;
  redirect(url: string): void;
  send(body: string): AuthResponse;
  setHeader(name: string, value: string | string[]): AuthResponse;
  status(code: number): AuthResponse;
}

type AuthNextFunction = () => void;

interface AuthAppLike {
  get(path: string, handler: (req: AuthRequest, res: AuthResponse) => unknown): void;
  post(path: string, handler: (req: AuthRequest, res: AuthResponse) => unknown): void;
}

interface LoginPageOptions {
  csrfToken: string;
  error: string | null;
  providerName: string;
  returnTo: string;
  themeChoice?: string;
}

interface DisabledPageOptions {
  providerName: string;
  themeChoice?: string;
}

interface SignedInPageOptions {
  csrfToken: string;
  providerName: string;
  subjectId: string;
  themeChoice?: string;
}

export interface OwnerAuthPlaceholderOptions {
  /**
   * Optional explicit CSRF HMAC secret. Defaults to a fresh random
   * 32-byte buffer minted per process. The default is the right
   * answer for almost everyone — explicit override exists only for
   * tests, deterministic fixtures, and the rare deployment that needs
   * a stable secret across restarts. Operators SHALL NOT set this to
   * a password-derived value.
   */
  csrfSecret?: OwnerCsrfSecret | null;
  forceSecureCookies?: boolean;
  password?: string | null;
  providerName?: string;
  sameSite?: OwnerSessionSameSite;
  sessionTtlSeconds?: number;
  subjectId?: string | null;
}

export interface OwnerAuthPlaceholder {
  attachRoutes(app: AuthAppLike): void;
  readonly csrfCookieName: string;
  readonly csrfFieldName: string;
  readonly enabled: boolean;
  ensureCsrfToken(req: AuthRequest, res: AuthResponse): string;
  /**
   * Soft session reader — returns the validated owner session payload when
   * the request carries one, or null when it doesn't. Unlike
   * `requireOwnerSession`, this never sends a response. Use from routes that
   * accept anonymous traffic but want to behave differently when an owner
   * happens to be signed in (e.g. `/oauth/register` stamping
   * `issuer_subject_id`).
   */
  readOwnerSession(req: AuthRequest): OwnerSessionPayload | null;
  renderCsrfField(token: string): string;
  requireCsrf(req: AuthRequest, res: AuthResponse, next: AuthNextFunction): void;
  requireOwnerSession(req: AuthRequest, res: AuthResponse, next: AuthNextFunction): void;
  readonly subjectId: string;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isSecureRequest(req: AuthRequest): boolean {
  if (req.secure) {
    return true;
  }
  const forwarded = req.headers["x-forwarded-proto"];
  if (typeof forwarded === "string") {
    const first = forwarded.split(",")[0];
    if (first && first.trim() === "https") {
      return true;
    }
  }
  return false;
}

function wantsHtml(req: AuthRequest): boolean {
  const accept = req.headers.accept;
  if (typeof accept !== "string") {
    return false;
  }
  // Accept headers from browsers always include text/html; API clients
  // typically send application/json or */* without text/html.
  return accept.includes("text/html");
}

function renderLoginPage({ providerName, error, returnTo, csrfToken, themeChoice }: LoginPageOptions): string {
  const safeReturnTo = typeof returnTo === "string" ? returnTo : "";
  const errorBlock = error ? `<div class="hosted-ui-error" role="alert">${hostedEscape(error)}</div>` : "";
  const form = `<form class="hosted-ui-surface" method="POST" action="/owner/login" data-surface="human" aria-label="Owner sign-in">
  ${renderCsrfHiddenField(csrfToken)}
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
      eyebrow: "Owner sign-in",
      title: `Sign in to ${providerName}`,
      lede: "This is the local placeholder owner auth for the reference implementation. It is not a full auth product.",
    }),
    form,
  ].join("\n");

  return renderHostedDocument({
    title: `${providerName} — Owner sign-in`,
    providerName,
    body,
    themeChoice,
  });
}

function renderOwnerAuthDisabledPage({ providerName, themeChoice }: DisabledPageOptions): string {
  const body = [
    renderPageIntro({
      eyebrow: "Owner approval UI",
      title: `${providerName} owner access`,
      lede: "Placeholder owner sign-in is disabled on this local reference instance, so approval pages remain open in local-dev mode.",
    }),
    renderSurface({
      surface: "human",
      ariaLabel: "Owner auth status",
      children: renderResultState({
        tone: "neutral",
        title: "Sign-in is not required right now",
        body: "Device approvals are open locally. Consent approvals still arrive through pending request links.",
        footnote: "Set PDPP_OWNER_PASSWORD to turn on the reference-only session gate.",
      }),
    }),
    renderSurface({
      surface: "protocol",
      ariaLabel: "Owner auth configuration details",
      children: renderKeyValueList([
        { label: "Current mode", value: "Open local-dev approval UI" },
        { label: "Enable sign-in", html: "<code>PDPP_OWNER_PASSWORD=&lt;password&gt;</code>" },
        { label: "Protected when enabled", value: "/consent*, /device*, /owner/login" },
        {
          label: "Consent pages",
          value: "Reached from a pending request authorization_url / request_uri flow",
        },
      ]),
    }),
    renderActionRow([{ href: "/device", label: "Open device approval UI", variant: "primary" }]),
  ].join("\n");

  return renderHostedDocument({
    title: `${providerName} — Owner access`,
    providerName,
    body,
    themeChoice,
  });
}

function renderSignedInOwnerPage({ providerName, subjectId, csrfToken, themeChoice }: SignedInPageOptions): string {
  const body = [
    renderPageIntro({
      eyebrow: "Owner approval UI",
      title: `${providerName} owner access`,
      lede: "You are signed in to the local placeholder owner-auth gate for the reference implementation.",
    }),
    renderSurface({
      surface: "human",
      ariaLabel: "Signed-in owner state",
      children: [
        renderResultState({
          tone: "success",
          title: "Signed in",
          body: "You can approve device flows directly here, or open a pending consent URL from a staged provider-connect request.",
          footnote: "This session is reference-only placeholder auth, not a full owner account system.",
        }),
        renderKeyValueList([{ label: "Owner subject", html: `<code>${hostedEscape(subjectId)}</code>` }]),
      ].join("\n"),
    }),
    renderActionRow([
      { href: "/dashboard", label: "Open dashboard", variant: "primary" },
      { href: "/device", label: "Open device approval UI" },
      {
        action: "/owner/logout",
        label: "Sign out",
        hidden: [{ name: OWNER_CSRF_FIELD_NAME, value: csrfToken }],
      },
    ]),
  ].join("\n");

  return renderHostedDocument({
    title: `${providerName} — Owner access`,
    providerName,
    body,
    themeChoice,
  });
}

function pickReferrerHeader(headers: AuthRequestHeaders): string {
  if (typeof headers.referer === "string") {
    return headers.referer;
  }
  if (typeof headers.referrer === "string") {
    return headers.referrer;
  }
  return "";
}

// ASCII control chars (U+0000..U+001F) and DEL (U+007F) are intentionally
// disallowed in `return_to` so the placeholder can't be abused as an open
// redirect. We do the check with charCodeAt instead of a regex to avoid
// Biome's noControlCharactersInRegex lint (the rule is about accidental
// inclusion; this is an intentional security sanitizer).
function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize a `return_to` form/query parameter to a same-origin path. We
 * reject anything that looks like an absolute URL or protocol-relative URL
 * so the placeholder cannot be abused as an open redirect.
 */
function sanitizeReturnTo(input: unknown): string {
  if (typeof input !== "string" || !input) {
    return DEFAULT_RETURN_TO;
  }
  // Must start with a single '/' and not '//' (protocol-relative) and not contain \\
  if (!input.startsWith("/")) {
    return DEFAULT_RETURN_TO;
  }
  if (input.startsWith("//")) {
    return DEFAULT_RETURN_TO;
  }
  if (input.includes("\\")) {
    return DEFAULT_RETURN_TO;
  }
  if (containsControlCharacter(input)) {
    return DEFAULT_RETURN_TO;
  }
  return input;
}

function deriveRequestOrigin(req: AuthRequest): string | null {
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  if (!host) {
    return null;
  }
  return `${isSecureRequest(req) ? "https" : "http"}://${host}`;
}

function deriveReturnToFromRequest(req: AuthRequest): string {
  const originalUrl = sanitizeReturnTo(req.originalUrl || req.url || DEFAULT_RETURN_TO);
  if (req.method === "GET" || req.method === "HEAD") {
    return originalUrl;
  }

  const referrer = pickReferrerHeader(req.headers);
  if (!referrer) {
    return originalUrl;
  }

  try {
    const referrerUrl = new URL(referrer);
    const currentOrigin = deriveRequestOrigin(req);
    if (!currentOrigin || referrerUrl.origin !== currentOrigin) {
      return originalUrl;
    }
    return sanitizeReturnTo(`${referrerUrl.pathname || "/"}${referrerUrl.search || ""}${referrerUrl.hash || ""}`);
  } catch {
    return originalUrl;
  }
}

function readReturnToFromQuery(req: AuthRequest): string {
  const raw = req.query?.return_to;
  return sanitizeReturnTo(typeof raw === "string" ? raw : "");
}

function readReturnToFromBodyOrQuery(req: AuthRequest): string {
  const bodyReturnTo = req.body && typeof req.body.return_to === "string" ? req.body.return_to : "";
  if (bodyReturnTo) {
    return sanitizeReturnTo(bodyReturnTo);
  }
  return readReturnToFromQuery(req);
}

interface SessionHelpers {
  clearSession(res: AuthResponse, req: AuthRequest): void;
  issueSession(res: AuthResponse, req: AuthRequest): void;
  readSession(req: AuthRequest): OwnerSessionPayload | null;
}

function appendSetCookie(res: AuthResponse, value: string): void {
  // Preserve any prior Set-Cookie headers (we may set both the session
  // cookie and the CSRF cookie on the same response). `res.setHeader`
  // overwrites; passing an array preserves all values for Node/Express.
  const existing = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : undefined;
  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing.map(String), value]);
    return;
  }
  if (typeof existing === "string" && existing) {
    res.setHeader("Set-Cookie", [existing, value]);
    return;
  }
  res.setHeader("Set-Cookie", value);
}

function buildSessionHelpers(controller: OwnerSessionController): SessionHelpers {
  return {
    issueSession(res: AuthResponse, req: AuthRequest): void {
      const cookieHeader = controller.issueSessionCookieHeader({ secure: isSecureRequest(req) });
      if (cookieHeader) {
        appendSetCookie(res, cookieHeader);
      }
    },
    clearSession(res: AuthResponse, req: AuthRequest): void {
      appendSetCookie(res, controller.clearSessionCookieHeader({ secure: isSecureRequest(req) }));
    },
    readSession(req: AuthRequest): OwnerSessionPayload | null {
      return controller.readSessionFromCookieHeader(req.headers.cookie);
    },
  };
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
  providerName = "PDPP Reference Provider",
  sessionTtlSeconds = OWNER_SESSION_DEFAULT_TTL_SECONDS,
  sameSite = "lax",
  forceSecureCookies = false,
  csrfSecret: csrfSecretOverride = null,
}: OwnerAuthPlaceholderOptions = {}): OwnerAuthPlaceholder {
  // `exactOptionalPropertyTypes` won't accept `undefined` in these fields,
  // so we fall back to the declared `null` sentinel the controller already
  // understands as "not provided."
  const sessionController = createOwnerSessionController({
    password: password ?? null,
    subjectId: subjectId ?? null,
    sessionTtlSeconds,
    sameSite,
    forceSecureCookies,
  });
  const { enabled, subjectId: resolvedSubjectId } = sessionController;
  const session = buildSessionHelpers(sessionController);
  // CSRF protection is only meaningful when owner-auth is enabled (the
  // password gates everything). When disabled, the helpers no-op and
  // the routes stay open as before.
  //
  // The CSRF HMAC secret is **not** derived from the owner password.
  // GET /owner/login is unauthenticated and returns a signed token in
  // the hidden field, so any password-derived secret would expose one
  // HMAC sample to every anonymous fetcher and let them brute-force a
  // weak password offline. We mint a random 32-byte secret per process
  // instead. An operator who needs a stable secret across restarts
  // SHOULD pass an explicit `csrfSecret` (high-entropy, unrelated to
  // any user input) — but the default is the random secret.
  const csrfSecret: OwnerCsrfSecret | null = enabled ? (csrfSecretOverride ?? generateOwnerCsrfSecret()) : null;

  function ensureCsrfToken(req: AuthRequest, res: AuthResponse): string {
    if (!csrfSecret) {
      return "";
    }
    const fromCookie = readCsrfTokenFromCookieHeader(req.headers.cookie);
    // Reuse the cookie value only if the signature still verifies; an
    // injected/forged cookie would fail verification and is rotated out.
    if (fromCookie && verifyOwnerCsrfToken(fromCookie, csrfSecret)) {
      return fromCookie;
    }
    const token = issueOwnerCsrfToken(csrfSecret);
    appendSetCookie(
      res,
      buildOwnerCsrfSetCookie(token, {
        secure: forceSecureCookies || isSecureRequest(req),
        sameSite,
        maxAgeSeconds: sessionTtlSeconds,
      })
    );
    // Ensure subsequent reads in the same request see the freshly minted
    // token via the request cookie header.
    const nextHeader = req.headers.cookie
      ? `${req.headers.cookie}; ${OWNER_CSRF_COOKIE_NAME}=${token}`
      : `${OWNER_CSRF_COOKIE_NAME}=${token}`;
    (req as unknown as { headers: Record<string, string> }).headers.cookie = nextHeader;
    return token;
  }

  function rotateCsrfCookie(req: AuthRequest, res: AuthResponse): void {
    appendSetCookie(
      res,
      buildOwnerCsrfClearCookie({
        secure: forceSecureCookies || isSecureRequest(req),
        sameSite,
      })
    );
  }

  function isJsonRequest(req: AuthRequest): boolean {
    // Pure JSON callers (CLIs, server-to-server, dashboards using
    // `fetch` with `Content-Type: application/json`) cannot be forged
    // into a cross-origin browser POST without a CORS preflight, so
    // we exempt them from CSRF and preserve existing JSON API
    // behavior. The exemption is intentionally limited to exactly
    // `application/json`: the reference's Fastify body parser only
    // parses `application/json`, so accepting structured-syntax
    // variants like `application/problem+json` for CSRF purposes
    // would diverge from what the route handlers actually decode.
    const contentType =
      typeof (req.headers as Record<string, unknown>)["content-type"] === "string"
        ? ((req.headers as Record<string, string>)["content-type"] as string).toLowerCase()
        : "";
    if (!contentType) {
      return false;
    }
    const mediaType = contentType.split(";")[0]?.trim() ?? "";
    return mediaType === "application/json";
  }

  function shouldRequireCsrf(req: AuthRequest): boolean {
    // Every browser-submittable POST that is *not* JSON needs CSRF.
    // That includes the obvious form encodings
    // (`application/x-www-form-urlencoded`, `multipart/form-data`)
    // *and* `text/plain`, which the HTML form spec accepts as a third
    // valid `enctype` and which a browser can send cross-origin
    // without a CORS preflight. Exempting only the two form encodings
    // (the prior heuristic) left a `text/plain` bypass.
    return !isJsonRequest(req);
  }

  function requireCsrf(req: AuthRequest, res: AuthResponse, next: AuthNextFunction): void {
    if (!(enabled && csrfSecret)) {
      // Owner-auth disabled — no session, no CSRF surface to protect.
      next();
      return;
    }
    if (!shouldRequireCsrf(req)) {
      next();
      return;
    }
    const cookieToken = readCsrfTokenFromCookieHeader(req.headers.cookie);
    const formToken =
      (req.body && typeof (req.body as Record<string, unknown>)[OWNER_CSRF_FIELD_NAME] === "string"
        ? ((req.body as Record<string, unknown>)[OWNER_CSRF_FIELD_NAME] as string)
        : "") || "";
    if (!(csrfSecret && validateOwnerCsrfPair(cookieToken, formToken, csrfSecret))) {
      if (wantsHtml(req)) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.status(403).send(
          renderHostedDocument({
            title: `${providerName} — Request blocked`,
            providerName,
            body: [
              renderPageIntro({
                eyebrow: "Owner approval UI",
                title: "Request blocked",
                lede: "The form submission is missing a valid CSRF token. Reload the page and try again from a freshly rendered owner-hosted form.",
              }),
            ].join("\n"),
          })
        );
        return;
      }
      res
        .status(403)
        .setHeader("Content-Type", "application/json")
        .json({
          error: {
            type: "invalid_request",
            code: "csrf_token_invalid",
            message: "CSRF token missing or invalid for hosted owner form POST.",
          },
        });
      return;
    }
    next();
  }

  function extractCsrfFormToken(req: AuthRequest): string {
    if (!req.body) {
      return "";
    }
    const value = (req.body as Record<string, unknown>)[OWNER_CSRF_FIELD_NAME];
    return typeof value === "string" ? value : "";
  }

  function csrfPairValid(req: AuthRequest): boolean {
    if (!csrfSecret) {
      return false;
    }
    const cookieToken = readCsrfTokenFromCookieHeader(req.headers.cookie);
    const formToken = extractCsrfFormToken(req);
    return validateOwnerCsrfPair(cookieToken, formToken, csrfSecret);
  }

  function passwordMatches(submitted: string): boolean {
    if (!submitted || typeof password !== "string" || !password) {
      return false;
    }
    return timingSafeEqualString(submitted, password);
  }

  function replyDisabledLogin(req: AuthRequest, res: AuthResponse): void {
    if (wantsHtml(req)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(400).send(
        renderOwnerAuthDisabledPage({
          providerName,
          themeChoice: readHostedThemeChoiceFromCookieHeader(req.headers.cookie),
        })
      );
      return;
    }
    res
      .status(400)
      .setHeader("Content-Type", "application/json")
      .json({
        error: {
          type: "invalid_request",
          code: "owner_auth_disabled",
          message: "Owner placeholder auth is disabled on this reference instance.",
        },
      });
  }

  function replyLogoutCsrfFailure(req: AuthRequest, res: AuthResponse): void {
    if (wantsHtml(req)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(403).send(
        renderHostedDocument({
          title: `${providerName} — Request blocked`,
          providerName,
          body: renderPageIntro({
            eyebrow: "Owner approval UI",
            title: "Request blocked",
            lede: "The sign-out submission is missing a valid CSRF token. Reload the page and try again.",
          }),
        })
      );
      return;
    }
    res
      .status(403)
      .setHeader("Content-Type", "application/json")
      .json({
        error: {
          type: "invalid_request",
          code: "csrf_token_invalid",
          message: "CSRF token missing or invalid for /owner/logout.",
        },
      });
  }

  function attachRoutes(app: AuthAppLike): void {
    app.get("/owner/login", (req, res) => {
      const hasExplicitReturnTo = typeof req.query?.return_to === "string" && req.query.return_to.length > 0;
      const returnTo = readReturnToFromQuery(req);
      res.setHeader("Content-Type", "text/html; charset=utf-8");

      if (!enabled) {
        res.status(200).send(
          renderOwnerAuthDisabledPage({
            providerName,
            themeChoice: readHostedThemeChoiceFromCookieHeader(req.headers.cookie),
          })
        );
        return;
      }

      const currentSession = session.readSession(req);
      if (currentSession) {
        if (hasExplicitReturnTo) {
          res.redirect(returnTo);
          return;
        }
        const csrfToken = ensureCsrfToken(req, res);
        res.status(200).send(
          renderSignedInOwnerPage({
            providerName,
            subjectId: resolvedSubjectId,
            csrfToken,
            themeChoice: readHostedThemeChoiceFromCookieHeader(req.headers.cookie),
          })
        );
        return;
      }

      const csrfToken = ensureCsrfToken(req, res);
      res.status(200).send(
        renderLoginPage({
          providerName,
          error: null,
          returnTo,
          csrfToken,
          themeChoice: readHostedThemeChoiceFromCookieHeader(req.headers.cookie),
        })
      );
    });

    app.post("/owner/login", (req, res) => {
      const returnTo = readReturnToFromBodyOrQuery(req);

      if (!enabled) {
        replyDisabledLogin(req, res);
        return;
      }

      // Enforce CSRF before any password check so attackers can't probe
      // password validity over a forged cross-origin POST. We render the
      // CSRF failure page rather than re-rendering the login form so we
      // don't leak whether the password attempt would have succeeded.
      //
      // Pure JSON callers stay exempt for the same reason as the rest
      // of the hosted-form CSRF surface: a cross-origin browser POST
      // with `Content-Type: application/json` requires a CORS preflight
      // and cannot be silently forged, so JSON `/owner/login` keeps
      // its programmatic contract and reaches the password branch.
      if (shouldRequireCsrf(req) && !csrfPairValid(req)) {
        const csrfToken = ensureCsrfToken(req, res);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.status(403).send(
          renderLoginPage({
            providerName,
            error: "Session expired or form replay detected. Please try again.",
            returnTo,
            csrfToken,
            themeChoice: readHostedThemeChoiceFromCookieHeader(req.headers.cookie),
          })
        );
        return;
      }

      const submitted = req.body && typeof req.body.password === "string" ? req.body.password : "";
      if (!passwordMatches(submitted)) {
        const csrfToken = ensureCsrfToken(req, res);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.status(401).send(
          renderLoginPage({
            providerName,
            error: "Incorrect password.",
            returnTo,
            csrfToken,
            themeChoice: readHostedThemeChoiceFromCookieHeader(req.headers.cookie),
          })
        );
        return;
      }
      session.issueSession(res, req);
      // Rotate the CSRF cookie on auth-state change so a token captured
      // from a pre-login response cannot be reused after sign-in.
      rotateCsrfCookie(req, res);
      res.redirect(returnTo);
    });

    app.post("/owner/logout", (req, res) => {
      // CSRF only applies when owner-auth is enabled. With placeholder
      // auth disabled (no PDPP_OWNER_PASSWORD), there is no session
      // and no CSRF surface to protect; preserve the prior open
      // local-dev behavior so a form-encoded logout POST does not 403.
      // Pure JSON callers stay exempt because they cannot be
      // cross-origin-forged without a CORS preflight; every other
      // browser-submittable POST (form-encoded, multipart, text/plain)
      // requires a valid CSRF pair.
      if (enabled && shouldRequireCsrf(req) && !csrfPairValid(req)) {
        replyLogoutCsrfFailure(req, res);
        return;
      }
      session.clearSession(res, req);
      rotateCsrfCookie(req, res);
      if (wantsHtml(req)) {
        res.redirect("/owner/login");
        return;
      }
      res.status(204).end();
    });
  }

  function requireOwnerSession(req: AuthRequest, res: AuthResponse, next: AuthNextFunction): void {
    if (!enabled) {
      // Disabled: fall through to current open local-dev behavior.
      next();
      return;
    }

    const current = session.readSession(req);
    if (current) {
      req.ownerSession = current;
      next();
      return;
    }

    if (wantsHtml(req)) {
      const returnTo = encodeURIComponent(deriveReturnToFromRequest(req));
      res.redirect(`/owner/login?return_to=${returnTo}`);
      return;
    }
    res
      .status(401)
      .setHeader("Content-Type", "application/json")
      .json({
        error: {
          type: "authentication_error",
          code: "owner_session_required",
          message:
            "Owner session required. This is the reference implementation placeholder owner auth; sign in at /owner/login.",
        },
      });
  }

  return {
    enabled,
    subjectId: resolvedSubjectId,
    attachRoutes,
    requireOwnerSession,
    readOwnerSession: (req) => session.readSession(req),
    requireCsrf,
    ensureCsrfToken,
    renderCsrfField: renderCsrfHiddenField,
    csrfFieldName: OWNER_CSRF_FIELD_NAME,
    csrfCookieName: OWNER_CSRF_COOKIE_NAME,
  };
}

export const OWNER_AUTH_DEFAULT_SUBJECT_ID = OWNER_SESSION_DEFAULT_SUBJECT_ID;
export const OWNER_AUTH_COOKIE_NAME = OWNER_SESSION_COOKIE_NAME;
