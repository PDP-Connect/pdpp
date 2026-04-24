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
  renderActionRow,
  renderHostedDocument,
  renderKeyValueList,
  renderPageIntro,
  renderResultState,
  renderSurface,
} from "./hosted-ui.js";
import {
  createOwnerSessionController,
  OWNER_SESSION_COOKIE_NAME,
  OWNER_SESSION_DEFAULT_SUBJECT_ID,
  OWNER_SESSION_DEFAULT_TTL_SECONDS,
  type OwnerSessionController,
  type OwnerSessionPayload,
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
  json(body: unknown): AuthResponse;
  redirect(url: string): void;
  send(body: string): AuthResponse;
  setHeader(name: string, value: string): AuthResponse;
  status(code: number): AuthResponse;
}

type AuthNextFunction = () => void;

interface AuthAppLike {
  get(path: string, handler: (req: AuthRequest, res: AuthResponse) => unknown): void;
  post(path: string, handler: (req: AuthRequest, res: AuthResponse) => unknown): void;
}

interface LoginPageOptions {
  error: string | null;
  providerName: string;
  returnTo: string;
}

interface DisabledPageOptions {
  providerName: string;
}

interface SignedInPageOptions {
  providerName: string;
  subjectId: string;
}

export interface OwnerAuthPlaceholderOptions {
  password?: string | null;
  providerName?: string;
  sessionTtlSeconds?: number;
  subjectId?: string | null;
}

export interface OwnerAuthPlaceholder {
  attachRoutes(app: AuthAppLike): void;
  readonly enabled: boolean;
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

function renderLoginPage({ providerName, error, returnTo }: LoginPageOptions): string {
  const safeReturnTo = typeof returnTo === "string" ? returnTo : "";
  const errorBlock = error ? `<div class="hosted-ui-error" role="alert">${hostedEscape(error)}</div>` : "";
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
  });
}

function renderOwnerAuthDisabledPage({ providerName }: DisabledPageOptions): string {
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
  });
}

function renderSignedInOwnerPage({ providerName, subjectId }: SignedInPageOptions): string {
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
      { href: "/device", label: "Open device approval UI", variant: "primary" },
      { action: "/owner/logout", label: "Sign out" },
    ]),
  ].join("\n");

  return renderHostedDocument({
    title: `${providerName} — Owner access`,
    providerName,
    body,
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

function buildSessionHelpers(controller: OwnerSessionController): SessionHelpers {
  return {
    issueSession(res: AuthResponse, req: AuthRequest): void {
      const cookieHeader = controller.issueSessionCookieHeader({ secure: isSecureRequest(req) });
      if (cookieHeader) {
        res.setHeader("Set-Cookie", cookieHeader);
      }
    },
    clearSession(res: AuthResponse, req: AuthRequest): void {
      res.setHeader("Set-Cookie", controller.clearSessionCookieHeader({ secure: isSecureRequest(req) }));
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
}: OwnerAuthPlaceholderOptions = {}): OwnerAuthPlaceholder {
  // `exactOptionalPropertyTypes` won't accept `undefined` in these fields,
  // so we fall back to the declared `null` sentinel the controller already
  // understands as "not provided."
  const sessionController = createOwnerSessionController({
    password: password ?? null,
    subjectId: subjectId ?? null,
    sessionTtlSeconds,
  });
  const { enabled, subjectId: resolvedSubjectId } = sessionController;
  const session = buildSessionHelpers(sessionController);

  function attachRoutes(app: AuthAppLike): void {
    app.get("/owner/login", (req, res) => {
      const hasExplicitReturnTo = typeof req.query?.return_to === "string" && req.query.return_to.length > 0;
      const returnTo = readReturnToFromQuery(req);
      res.setHeader("Content-Type", "text/html; charset=utf-8");

      if (!enabled) {
        res.status(200).send(renderOwnerAuthDisabledPage({ providerName }));
        return;
      }

      const currentSession = session.readSession(req);
      if (currentSession) {
        if (hasExplicitReturnTo) {
          res.redirect(returnTo);
          return;
        }
        res.status(200).send(renderSignedInOwnerPage({ providerName, subjectId: resolvedSubjectId }));
        return;
      }

      res.status(200).send(renderLoginPage({ providerName, error: null, returnTo }));
    });

    app.post("/owner/login", (req, res) => {
      const returnTo = readReturnToFromBodyOrQuery(req);

      if (!enabled) {
        if (wantsHtml(req)) {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.status(400).send(renderOwnerAuthDisabledPage({ providerName }));
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
        return;
      }

      const submitted = req.body && typeof req.body.password === "string" ? req.body.password : "";
      if (!submitted || typeof password !== "string" || !timingSafeEqualString(submitted, password)) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.status(401).send(
          renderLoginPage({
            providerName,
            error: "Incorrect password.",
            returnTo,
          })
        );
        return;
      }
      session.issueSession(res, req);
      res.redirect(returnTo);
    });

    app.post("/owner/logout", (req, res) => {
      session.clearSession(res, req);
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
  };
}

export const OWNER_AUTH_DEFAULT_SUBJECT_ID = OWNER_SESSION_DEFAULT_SUBJECT_ID;
export const OWNER_AUTH_COOKIE_NAME = OWNER_SESSION_COOKIE_NAME;
