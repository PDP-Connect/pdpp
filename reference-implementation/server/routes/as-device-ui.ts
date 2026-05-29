// HTTP adapter for the AS owner device-verification UI route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§6).
//
// Covers:
//   GET  /device          — owner-session-gated verification code entry / approval form
//   POST /device/approve  — owner-session + CSRF gated device-code approval
//   POST /device/deny     — owner-session + CSRF gated device-code denial
//
// Auth posture: all three routes require an owner session. /device/approve and
// /device/deny additionally require CSRF enforcement.
//
// Canonical operation:
//   operations/as-device-decision/index.ts → approve/deny semantics,
//     approval_id→user_code resolution, error mapping

import {
  type AsDeviceDecisionDependencies,
  executeAsDeviceDecision,
} from "../../operations/as-device-decision/index.ts";
import type { RouteArg } from "./_route-contract.ts";

// ─── Minimal structural types ────────────────────────────────────────────────

interface RouteRequest {
  readonly body?: Record<string, unknown> | null;
  readonly query?: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  send(body: string): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): RouteResponse;
}

type NextFn = () => void;
type MiddlewareFn = (req: RouteRequest, res: RouteResponse, next: NextFn) => Promise<void> | void;
type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<void>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler | MiddlewareFn>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler | MiddlewareFn>[]): AppLike;
}

// ─── Hosted-UI rendering surface (injected to avoid importing .js directly) ──

export interface HostedUiRenderer {
  escapeHtml(input: unknown): string;
  renderEmptyState(opts: {
    form?: {
      method: string;
      action: string;
      submitLabel: string;
      fields: Array<{
        name: string;
        label: string;
        value: string;
        autofocus?: boolean;
        autocomplete?: string;
      }>;
    };
  }): string;
  renderHostedDocument(opts: { title: string; providerName: string; body: string }): string;
  renderKeyValueList(items: Array<{ label: string; value?: unknown; html?: string }>): string;
  renderPageIntro(opts: { eyebrow: string; title: string; lede?: string }): string;
  renderResultState(opts: { tone: string; title: string; body: string }): string;
  renderSurface(opts: { surface?: string; children: string }): string;
}

// ─── Injected capabilities ───────────────────────────────────────────────────

export interface OwnerDeviceAuthPendingRow {
  readonly client_id: string;
  readonly expires_at: unknown;
  readonly user_code: string;
}

export interface MountAsDeviceUiContext {
  /** Device-decision store capabilities. */
  deviceDecision: AsDeviceDecisionDependencies;
  /** Generates a fresh CSRF token and sets it in the response. */
  ensureCsrfToken(req: RouteRequest, res: RouteResponse): string;
  /** Looks up a pending device-auth record by user_code; null if not found. */
  getByUserCode(userCode: string): Promise<OwnerDeviceAuthPendingRow | null> | OwnerDeviceAuthPendingRow | null;
  /** Writes an OAuth error envelope (`error` / `error_description`). */
  oauthError(res: unknown, status: number, code: string, message: string): unknown;
  /** Default subject ID used when owner-auth is disabled and no subject_id in form body. */
  ownerAuthDefaultSubjectId: string;
  /** Whether owner-session auth is enabled on this server instance. */
  ownerAuthEnabled: boolean;
  /** The subject ID of the currently signed-in owner. Only valid when ownerAuthEnabled is true. */
  ownerSubjectId: string;
  /** Human-readable display name for the provider (shown in page titles). */
  providerName: string;
  /** Renders a hidden CSRF input field for the given token. */
  renderCsrfField(token: string): string;
  /** CSRF enforcement middleware. */
  requireCsrf: MiddlewareFn;
  /** Owner-session enforcement middleware. */
  requireOwnerSession: MiddlewareFn;
  /** Attaches a trace-id header to the response. */
  setReferenceTraceId(res: unknown, traceId: string): void;
  /** Hosted-UI rendering helpers injected to avoid a direct .js import. */
  ui: HostedUiRenderer;
}

// ─── Route mount ─────────────────────────────────────────────────────────────

export function mountAsDeviceUi(app: AppLike, ctx: MountAsDeviceUiContext): void {
  const getHandler: RouteHandler = async (req, res): Promise<void> => {
    const { ui } = ctx;
    const userCode = typeof req.query?.user_code === "string" ? req.query.user_code : "";
    const pending = userCode ? await ctx.getByUserCode(userCode) : null;

    if (!(userCode && pending)) {
      const emptyBody = [
        ui.renderPageIntro({
          eyebrow: "Device verification",
          title: "Enter verification code",
          lede: "Paste the code shown by the CLI to continue the owner sign-in flow.",
        }),
        ui.renderEmptyState({
          form: {
            method: "GET",
            action: "/device",
            submitLabel: "Continue",
            fields: [
              {
                name: "user_code",
                label: "User code",
                value: userCode || "",
                autofocus: true,
                autocomplete: "one-time-code",
              },
            ],
          },
        }),
      ].join("\n");
      res.send(
        ui.renderHostedDocument({
          title: `${ctx.providerName} — Device verification`,
          providerName: ctx.providerName,
          body: emptyBody,
        })
      );
      return;
    }

    const facts = ui.renderKeyValueList([
      { label: "Client", value: pending.client_id },
      { label: "User code", html: `<span class="hosted-ui-code">${ui.escapeHtml(pending.user_code)}</span>` },
      { label: "Expires", value: pending.expires_at },
    ]);

    const ownerBlock = ctx.ownerAuthEnabled
      ? ui.renderKeyValueList([
          {
            label: "Owner subject",
            html: `<code>${ui.escapeHtml(ctx.ownerSubjectId)}</code> <span class="pdpp-caption">signed-in owner</span>`,
          },
        ])
      : `<div class="hosted-ui-field">
  <label for="hosted-ui-subject_id">Subject ID</label>
  <input id="hosted-ui-subject_id" name="subject_id" value="owner_local" type="text" />
</div>`;

    const csrfToken = ctx.ensureCsrfToken(req, res);
    const csrfField = ctx.renderCsrfField(csrfToken);
    const formOpen = `<form class="hosted-ui-surface" method="POST" action="/device/approve" data-surface="human" aria-label="Approve CLI access">
  ${csrfField}
  <input type="hidden" name="user_code" value="${ui.escapeHtml(pending.user_code)}" />
  ${facts}
  ${ownerBlock}
  <div class="hosted-ui-actions">
    <button type="submit" class="hosted-ui-button" data-variant="primary">Approve and issue owner token</button>
    <button type="submit" class="hosted-ui-button" data-variant="danger" formaction="/device/deny">Deny</button>
  </div>
</form>`;

    const body = [
      ui.renderPageIntro({
        eyebrow: "Device verification",
        title: `Approve owner access to ${ctx.providerName}`,
        lede: "A CLI is asking to sign in on your behalf. Approve only if you started this on a device you trust.",
      }),
      formOpen,
    ].join("\n");

    res.send(
      ui.renderHostedDocument({
        title: `${ctx.providerName} — Approve CLI access`,
        providerName: ctx.providerName,
        body,
      })
    );
  };

  // Device approve/deny decision semantics (approval_id → user_code
  // resolution behind the owner-session + CSRF gate, store call, error
  // mapping) live in the canonical `as.device.decision` operation
  // (operations/as-device-decision). The host adapter owns owner-session
  // + CSRF enforcement, subject-id resolution, and the hosted-UI HTML
  // result rendering.
  const approveHandler: RouteHandler = async (req, res): Promise<void> => {
    const { ui } = ctx;
    const subjectId = ctx.ownerAuthEnabled
      ? ctx.ownerSubjectId
      : (req.body?.subject_id as string) || ctx.ownerAuthDefaultSubjectId;
    const outcome = await executeAsDeviceDecision(
      {
        action: "approve",
        userCode: req.body?.user_code as string | null | undefined,
        approvalId: req.body?.approval_id as string | null | undefined,
        subjectId,
      },
      ctx.deviceDecision
    );
    if (outcome.outcome === "success") {
      res.send(
        ui.renderHostedDocument({
          title: `${ctx.providerName} — Device access approved`,
          providerName: ctx.providerName,
          body: [
            ui.renderPageIntro({ eyebrow: "Device verification", title: "Approved" }),
            ui.renderSurface({
              surface: "human",
              children: ui.renderResultState({
                tone: "success",
                title: "CLI access approved",
                body: "The CLI can return to polling and complete sign-in now.",
              }),
            }),
          ].join("\n"),
        })
      );
      return;
    }
    if (outcome.requestId) {
      res.setHeader("Request-Id", outcome.requestId);
    }
    if (outcome.traceId) {
      ctx.setReferenceTraceId(res, outcome.traceId);
    }
    ctx.oauthError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
  };

  const denyHandler: RouteHandler = async (req, res): Promise<void> => {
    const { ui } = ctx;
    const subjectId = ctx.ownerAuthEnabled
      ? ctx.ownerSubjectId
      : (req.body?.subject_id as string) || ctx.ownerAuthDefaultSubjectId;
    const outcome = await executeAsDeviceDecision(
      {
        action: "deny",
        userCode: req.body?.user_code as string | null | undefined,
        approvalId: req.body?.approval_id as string | null | undefined,
        subjectId,
      },
      ctx.deviceDecision
    );
    if (outcome.outcome === "success") {
      res.send(
        ui.renderHostedDocument({
          title: `${ctx.providerName} — Device access denied`,
          providerName: ctx.providerName,
          body: [
            ui.renderPageIntro({ eyebrow: "Device verification", title: "Denied" }),
            ui.renderSurface({
              children: ui.renderResultState({
                tone: "danger",
                title: "CLI access denied",
                body: "The CLI will stop polling and report that access was denied.",
              }),
            }),
          ].join("\n"),
        })
      );
      return;
    }
    if (outcome.requestId) {
      res.setHeader("Request-Id", outcome.requestId);
    }
    if (outcome.traceId) {
      ctx.setReferenceTraceId(res, outcome.traceId);
    }
    ctx.oauthError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
  };

  app.get("/device", ctx.requireOwnerSession as RouteArg<RouteHandler | MiddlewareFn>, getHandler);
  app.post(
    "/device/approve",
    ctx.requireOwnerSession as RouteArg<RouteHandler | MiddlewareFn>,
    ctx.requireCsrf as RouteArg<RouteHandler | MiddlewareFn>,
    approveHandler
  );
  app.post(
    "/device/deny",
    ctx.requireOwnerSession as RouteArg<RouteHandler | MiddlewareFn>,
    ctx.requireCsrf as RouteArg<RouteHandler | MiddlewareFn>,
    denyHandler
  );
}
