// HTTP adapter for the AS consent route family.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family`.
//
// Covers:
//   GET  /consent              — render pending-grant consent page
//   POST /consent/approve      — approve a pending grant (HTML or JSON branch)
//   POST /consent/deny         — deny a pending grant
//   POST /consent/exchange     — redeem single-use consent exchange code
//
// Auth posture:
//   GET  /consent              — ownerAuth.requireOwnerSession
//   POST /consent/approve      — ownerAuth.requireOwnerSession + ownerAuth.requireCsrf
//   POST /consent/deny         — ownerAuth.requireOwnerSession + ownerAuth.requireCsrf
//   POST /consent/exchange     — none (public, code is the credential)
//
// Rendering helpers (renderPendingConsentNotFoundHtml, renderPendingGrantConsentHtml,
// renderHostedDocument, etc.) live in `as-consent-ui-helpers.ts`. Operation
// semantics live in:
//   operations/as-consent-decision/index.ts
//   operations/as-consent-exchange/index.ts

import type {
  AsConsentDecisionDependencies,
  AsConsentDecisionPending,
  AsConsentDecisionPendingRow,
} from "../../operations/as-consent-decision/index.ts";
import { executeAsConsentDecision } from "../../operations/as-consent-decision/index.ts";
import type { AsConsentExchangeConsumeResult } from "../../operations/as-consent-exchange/index.ts";
import { executeAsConsentExchange } from "../../operations/as-consent-exchange/index.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../owner-auth.ts";
import type { PdppErrorFn, RouteArg } from "./_route-contract.ts";
import type { ConsentUiRenderer, PendingGrant } from "./as-consent-ui-helpers.ts";
import { renderPendingConsentNotFoundHtml, renderPendingGrantConsentHtml } from "./as-consent-ui-helpers.ts";

// ─── Local structural types ───────────────────────────────────────────────────

interface RouteRequest {
  accepts(types: string[]): string | false;
  readonly body?: Readonly<Record<string, unknown>>;
  is(mimeType: string): boolean | null;
  readonly ownerAuth?: { subjectId?: string } | null;
  readonly query: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  json(body: unknown): unknown;
  redirect(status: number, url: string): unknown;
  send(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): RouteResponse;
}

type NextFn = () => void;
type MiddlewareFn = (req: RouteRequest, res: RouteResponse, next: NextFn) => void | Promise<void>;
type RouteHandler = (req: RouteRequest, res: RouteResponse) => Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler | MiddlewareFn>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler | MiddlewareFn>[]): AppLike;
}

// ─── ownerAuth surface used by this adapter ───────────────────────────────────

interface OwnerAuth {
  readonly csrfFieldName: string;
  readonly enabled: boolean;
  ensureCsrfToken(req: RouteRequest, res: RouteResponse): string;
  requireCsrf: MiddlewareFn;
  requireOwnerSession: MiddlewareFn;
  readonly subjectId: string;
}

// ─── consentStore surface used by this adapter ────────────────────────────────

interface ConsentStore {
  approveGrant(
    deviceCode: string,
    subjectId: string,
    opts: unknown
  ): Promise<{
    grant: { grant_id: string; [k: string]: unknown };
    token: string;
    package?: boolean;
    package_id?: string;
  }>;
  denyGrant(deviceCode: string): Promise<boolean>;
  getPendingConsentByApprovalId(id: string): Promise<AsConsentDecisionPendingRow | null>;
  getPendingConsentByDeviceCode(deviceCode: string): Promise<PendingGrant | null>;
  parseRequestUri(requestUri: string): string | null;
}

// ─── agentConnectAttemptStore surface used by this adapter ────────────────────

interface AgentConnectAttemptStore {
  complete(requestUri: string | null | undefined, result: unknown): void;
  fail(requestUri: string | null | undefined, reason: string): void;
}

// ─── Context injected by the composition root ─────────────────────────────────

export interface MountAsConsentContext {
  agentConnectAttemptStore: AgentConnectAttemptStore;
  buildPendingConsentRequestUri(deviceCode: string): string;
  consentStore: ConsentStore;
  consentUi: ConsentUiRenderer;
  consumeConsentExchangeCode(code: string): Promise<AsConsentExchangeConsumeResult> | AsConsentExchangeConsumeResult;
  createConsentExchangeCode(opts: { grantId: string; token: string; grant: unknown }): string;
  handleError(res: unknown, err: unknown): void;
  issueOAuthAuthorizationCodeForDeviceCode(
    deviceCode: string | null,
    opts: { grantId: string; token: string }
  ): Promise<{ redirect_uri: string; code: string; state?: string | null } | null>;
  issueOAuthAuthorizationCodeForPackageDeviceCode(
    deviceCode: string | null,
    opts: { packageId: string; token: string }
  ): Promise<{ redirect_uri: string; code: string; state?: string | null } | null>;
  ownerAuth: OwnerAuth;
  pdppError: PdppErrorFn;
  providerName: string;
  setReferenceTraceId(res: unknown, traceId: string): void;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function renderApproveHtml(
  ctx: MountAsConsentContext,
  grant: { grant_id: string; [k: string]: unknown },
  token: string
): string {
  const exchangeCode = ctx.createConsentExchangeCode({ grantId: grant.grant_id, token, grant });
  return ctx.consentUi.renderHostedDocument({
    title: `${ctx.providerName} — Access approved`,
    providerName: ctx.providerName,
    body: [
      ctx.consentUi.renderPageIntro({
        eyebrow: "Consent result",
        title: "Access approved",
        lede: "A grant was issued for this request. Hand the exchange code below to the client that requested access; it will redeem the code for an access token over a fresh JSON request.",
      }),
      ctx.consentUi.renderSurface({
        surface: "human",
        children: ctx.consentUi.renderResultState({
          tone: "success",
          title: "Grant issued",
          body: "You can revoke this access any time from the grants dashboard. The exchange code is single-use and expires shortly.",
        }),
      }),
      ctx.consentUi.renderSurface({
        surface: "protocol",
        ariaLabel: "Technical grant details",
        children: ctx.consentUi.renderKeyValueList([
          { label: "Grant ID", html: `<code>${ctx.consentUi.escapeHtml(grant.grant_id)}</code>` },
          {
            label: "Consent exchange code",
            html: `<code>${ctx.consentUi.escapeHtml(exchangeCode)}</code>`,
          },
          { label: "Redeem at", html: "<code>POST /consent/exchange</code>" },
        ]),
      }),
    ].join("\n"),
  });
}

function renderPackageApproveHtml(
  ctx: MountAsConsentContext,
  grant: { grant_id: string; child_grants?: Array<{ grant_id?: string }>; [k: string]: unknown },
  packageId: string
): string {
  const childGrants = Array.isArray(grant.child_grants) ? grant.child_grants : [];
  return ctx.consentUi.renderHostedDocument({
    title: `${ctx.providerName} — Access approved`,
    providerName: ctx.providerName,
    body: [
      ctx.consentUi.renderPageIntro({
        eyebrow: "Consent result",
        title: "Source grants issued",
        lede: "The request was approved as independent source-bounded grants grouped under one package for audit.",
      }),
      ctx.consentUi.renderSurface({
        surface: "human",
        children: ctx.consentUi.renderResultState({
          tone: "success",
          title: `${childGrants.length} grant${childGrants.length === 1 ? "" : "s"} issued`,
          body: "You can revoke any single source grant independently from the grants dashboard.",
        }),
      }),
      ctx.consentUi.renderSurface({
        surface: "protocol",
        ariaLabel: "Technical package details",
        children: ctx.consentUi.renderKeyValueList([
          { label: "Package ID", html: `<code>${ctx.consentUi.escapeHtml(packageId)}</code>` },
          {
            label: "Child grant IDs",
            html: childGrants
              .map((child) => `<code>${ctx.consentUi.escapeHtml(String(child.grant_id || ""))}</code>`)
              .join("<br>"),
          },
        ]),
      }),
    ].join("\n"),
  });
}

function buildOAuthRedirectUrl(oauthCode: { redirect_uri: string; code: string; state?: string | null }): string {
  const redirectUrl = new URL(oauthCode.redirect_uri);
  redirectUrl.searchParams.set("code", oauthCode.code);
  if (oauthCode.state) {
    redirectUrl.searchParams.set("state", oauthCode.state);
  }
  return redirectUrl.toString();
}

async function dispatchApproveResponse(
  ctx: MountAsConsentContext,
  req: RouteRequest,
  res: RouteResponse,
  grant: { grant_id: string; [k: string]: unknown },
  token: string,
  approvedRequestUri: string | undefined,
  packageInfo?: { package: boolean; package_id?: string | undefined }
): Promise<void> {
  const deviceCode = ctx.consentStore.parseRequestUri(approvedRequestUri ?? "");
  const isPackage = Boolean(packageInfo?.package);
  const oauthCode = isPackage
    ? await ctx.issueOAuthAuthorizationCodeForPackageDeviceCode(deviceCode, {
        packageId: packageInfo?.package_id ?? grant.grant_id,
        token,
      })
    : await ctx.issueOAuthAuthorizationCodeForDeviceCode(deviceCode, {
        grantId: grant.grant_id,
        token,
      });
  if (oauthCode) {
    res.redirect(302, buildOAuthRedirectUrl(oauthCode));
    return;
  }
  ctx.agentConnectAttemptStore.complete(approvedRequestUri, { status: "approved", token, grant });
  const wantsJson = req.is("application/json") || req.accepts(["html", "json"]) === "json";
  if (wantsJson) {
    if (isPackage) {
      res.json({ package_id: packageInfo?.package_id ?? grant.grant_id, token, grant });
      return;
    }
    res.json({ grant_id: grant.grant_id, token, grant });
    return;
  }
  if (isPackage) {
    res.send(renderPackageApproveHtml(ctx, grant, packageInfo?.package_id ?? grant.grant_id));
    return;
  }
  // The HTML approval surface is the human-hosted owner consent page. The
  // bearer SHALL NOT appear anywhere in this response (browser history,
  // screenshots, screen-shares, password-manager autofill, chat
  // transcripts that paste the rendered page). Mint a single-use opaque
  // exchange code for the cold-agent handoff path; the client redeems it
  // at POST /consent/exchange to receive the bearer in a JSON body.
  // Spec: openspec/changes/harden-consent-token-handoff/specs/
  //       reference-implementation-architecture/spec.md
  res.send(renderApproveHtml(ctx, grant, token));
}

// Owner per-source narrowing keyed by staged source index. The narrowing
// directive is validated and enforced server-side (the AS may narrow, never
// widen); this adapter only normalizes transport shape. Two wire forms are
// accepted:
//   - JSON branch: a structured `source_narrowing` object (agent-friendly):
//       { "<index>": { streams?: string[], fields?: { [stream]: string[] }, since?: { [stream]: ISO } } }
//   - HTML form branch: flat fields the rendered ceremony posts:
//       narrow_streams_<index>            (repeated) - stream names to keep
//       narrow_fields_<index>__<stream>   (repeated) - field names to keep
//       narrow_since_<index>__<stream>    (single)   - tightened ISO since bound
//     `<stream>` is base64url-encoded in the field name to stay key-safe.
interface SourceNarrowing {
  fields?: Record<string, string[]>;
  since?: Record<string, string>;
  streams?: string[];
}

function decodeStreamKey(encoded: string | undefined): string | null {
  if (!encoded) {
    return null;
  }
  try {
    return Buffer.from(encoded, "base64url").toString("utf8") || null;
  } catch {
    return null;
  }
}

function asStringArray(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function parseStreamFieldMap(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }
  const fields: Record<string, string[]> = {};
  for (const [stream, fieldList] of Object.entries(raw as Record<string, unknown>)) {
    fields[stream] = asStringArray(fieldList);
  }
  return fields;
}

function parseStreamSinceMap(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }
  const since: Record<string, string> = {};
  for (const [stream, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      since[stream] = value;
    }
  }
  return since;
}

function parseStructuredSourceNarrowing(raw: unknown): Record<number, SourceNarrowing> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }
  const out: Record<number, SourceNarrowing> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(key);
    if (!(Number.isInteger(index) && value) || typeof value !== "object") {
      continue;
    }
    const entry = value as Record<string, unknown>;
    const narrowing: SourceNarrowing = {};
    if (Array.isArray(entry.streams)) {
      narrowing.streams = asStringArray(entry.streams);
    }
    const fields = parseStreamFieldMap(entry.fields);
    if (fields) {
      narrowing.fields = fields;
    }
    const since = parseStreamSinceMap(entry.since);
    if (since) {
      narrowing.since = since;
    }
    out[index] = narrowing;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const NARROW_STREAMS_KEY = /^narrow_streams_(\d+)$/;
const NARROW_FIELDS_KEY = /^narrow_fields_(\d+)__(.+)$/;
const NARROW_SINCE_KEY = /^narrow_since_(\d+)__(.+)$/;

function applyFlatNarrowingKey(out: Record<number, SourceNarrowing>, key: string, raw: unknown): void {
  const ensure = (index: number): SourceNarrowing => {
    out[index] = out[index] || {};
    return out[index];
  };

  const streamsMatch = NARROW_STREAMS_KEY.exec(key);
  if (streamsMatch) {
    const narrowing = ensure(Number(streamsMatch[1]));
    narrowing.streams = [...(narrowing.streams || []), ...asStringArray(raw)];
    return;
  }

  const fieldsMatch = NARROW_FIELDS_KEY.exec(key);
  if (fieldsMatch) {
    const stream = decodeStreamKey(fieldsMatch[2]);
    if (!stream) {
      return;
    }
    const narrowing = ensure(Number(fieldsMatch[1]));
    narrowing.fields = narrowing.fields || {};
    narrowing.fields[stream] = [...(narrowing.fields[stream] || []), ...asStringArray(raw)];
    return;
  }

  const sinceMatch = NARROW_SINCE_KEY.exec(key);
  if (sinceMatch) {
    const stream = decodeStreamKey(sinceMatch[2]);
    const value = asStringArray(raw)[0];
    if (!(stream && value)) {
      return;
    }
    const narrowing = ensure(Number(sinceMatch[1]));
    narrowing.since = narrowing.since || {};
    narrowing.since[stream] = value;
  }
}

// HTML checkboxes for a dropped stream still post their field/since values (only
// the stream checkbox went unchecked). Prune field/since directives for any
// stream the owner dropped, so an unchecked stream does not produce a
// contradictory directive the strict server validator would reject. When the
// owner left every stream checked, `narrow_streams_<index>` carries the full
// staged set, so this pruning is a no-op for the common path.
function pruneDroppedStreamDirectives(narrowing: SourceNarrowing): void {
  if (!narrowing.streams) {
    return;
  }
  const kept = new Set(narrowing.streams);
  for (const stream of Object.keys(narrowing.fields || {})) {
    if (!kept.has(stream)) {
      delete narrowing.fields?.[stream];
    }
  }
  for (const stream of Object.keys(narrowing.since || {})) {
    if (!kept.has(stream)) {
      delete narrowing.since?.[stream];
    }
  }
}

function parseFlatFormNarrowing(body: Readonly<Record<string, unknown>>): Record<number, SourceNarrowing> | undefined {
  const out: Record<number, SourceNarrowing> = {};
  for (const [key, raw] of Object.entries(body)) {
    applyFlatNarrowingKey(out, key, raw);
  }
  for (const narrowing of Object.values(out)) {
    pruneDroppedStreamDirectives(narrowing);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pruneFlatNarrowingToApprovedSources(
  narrowing: Record<number, SourceNarrowing> | undefined,
  approvedSourceIndexes: number[] | undefined
): Record<number, SourceNarrowing> | undefined {
  if (!(narrowing && approvedSourceIndexes)) {
    return narrowing;
  }
  const approved = new Set(approvedSourceIndexes);
  const pruned: Record<number, SourceNarrowing> = {};
  for (const [key, value] of Object.entries(narrowing)) {
    const index = Number(key);
    if (approved.has(index)) {
      pruned[index] = value;
    }
  }
  return Object.keys(pruned).length > 0 ? pruned : undefined;
}

function parseBatchApproveSelection(body: Readonly<Record<string, unknown>> | undefined): {
  approvedSourceIndexes?: number[];
  confirmedApproveAll?: boolean;
  sourceNarrowing?: Record<number, SourceNarrowing>;
} {
  const out: {
    approvedSourceIndexes?: number[];
    confirmedApproveAll?: boolean;
    sourceNarrowing?: Record<number, SourceNarrowing>;
  } = {};
  const raw = body?.approved_source_indexes;
  if (raw !== undefined && raw !== null) {
    const values = Array.isArray(raw) ? raw : [raw];
    const indexes: number[] = [];
    for (const value of values) {
      const index = typeof value === "number" ? value : Number(value);
      if (Number.isInteger(index)) {
        indexes.push(index);
      }
    }
    out.approvedSourceIndexes = indexes;
  }
  const confirm = body?.confirm_approve_all;
  if (confirm === true || confirm === "true" || confirm === "1" || confirm === "on") {
    out.confirmedApproveAll = true;
  }
  const structured = parseStructuredSourceNarrowing(body?.source_narrowing);
  const flat = body ? parseFlatFormNarrowing(body) : undefined;
  const narrowing = structured ?? pruneFlatNarrowingToApprovedSources(flat, out.approvedSourceIndexes);
  if (narrowing) {
    out.sourceNarrowing = narrowing;
  }
  return out;
}

// ─── Route mount ─────────────────────────────────────────────────────────────

export function mountAsConsent(app: AppLike, ctx: MountAsConsentContext): void {
  async function getPendingGrantFromRequestUri(requestUri: string): Promise<{
    deviceCode: string | null;
    pending: PendingGrant | null;
  }> {
    const deviceCode = ctx.consentStore.parseRequestUri(requestUri);
    if (!deviceCode) {
      return { deviceCode: null, pending: null };
    }
    const pending = await ctx.consentStore.getPendingConsentByDeviceCode(deviceCode);
    return { deviceCode, pending };
  }

  function buildConsentDecisionDeps(): AsConsentDecisionDependencies {
    return {
      getPendingConsentByApprovalId: (id) => ctx.consentStore.getPendingConsentByApprovalId(id),
      buildPendingConsentRequestUri: (deviceCode) => ctx.buildPendingConsentRequestUri(deviceCode),
      // PendingGrant is structurally richer than AsConsentDecisionPending; cast
      // is safe because the operation only reads trace_context from the pending row.
      getPendingFromRequestUri: (uri) =>
        getPendingGrantFromRequestUri(uri) as Promise<{
          deviceCode: string | null;
          pending: AsConsentDecisionPending | null;
        }>,
      approveGrant: (deviceCode, subjectId, opts2) => ctx.consentStore.approveGrant(deviceCode, subjectId, opts2),
      denyGrant: (deviceCode) => ctx.consentStore.denyGrant(deviceCode),
    };
  }

  // Primary consent shell for the current provider-connect request/approval profile.
  app.get(
    "/consent",
    ctx.ownerAuth.requireOwnerSession as RouteArg<RouteHandler | MiddlewareFn>,
    async (req: RouteRequest, res: RouteResponse): Promise<void> => {
      try {
        const requestUri = typeof req.query.request_uri === "string" ? req.query.request_uri : null;
        if (!requestUri) {
          ctx.pdppError(res, 400, "invalid_request", "request_uri is required");
          return;
        }
        const { pending } = await getPendingGrantFromRequestUri(requestUri);
        if (!pending) {
          res.status(404).send(renderPendingConsentNotFoundHtml(ctx.providerName, ctx.consentUi));
          return;
        }
        const csrfToken = ctx.ownerAuth.ensureCsrfToken(req, res);
        res.send(
          renderPendingGrantConsentHtml(
            pending,
            requestUri,
            csrfToken,
            ctx.ownerAuth.csrfFieldName,
            ctx.providerName,
            ctx.consentUi
          )
        );
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );

  // Consent approve/deny decision semantics (approval_id → request_uri
  // resolution, deviceCode resolution, store call, error mapping) live
  // in the canonical `as.consent.decision` operation
  // (operations/as-consent-decision). The host adapter owns owner-session
  // + CSRF enforcement, subject-id resolution, content negotiation
  // between the JSON and HTML approve branches, exchange-code minting,
  // and HTML rendering.
  app.post(
    "/consent/approve",
    { contract: "approveConsent" } as RouteArg<RouteHandler | MiddlewareFn>,
    ctx.ownerAuth.requireOwnerSession as RouteArg<RouteHandler | MiddlewareFn>,
    ctx.ownerAuth.requireCsrf as RouteArg<RouteHandler | MiddlewareFn>,
    async (req: RouteRequest, res: RouteResponse): Promise<void> => {
      try {
        const subjectId = ctx.ownerAuth.enabled
          ? ctx.ownerAuth.subjectId
          : (req.body?.subject_id as string | undefined) ||
            (req.query?.subject_id as string | undefined) ||
            OWNER_AUTH_DEFAULT_SUBJECT_ID;
        const outcome = await executeAsConsentDecision(
          {
            action: "approve",
            requestUri: (req.body?.request_uri || req.query?.request_uri) as string | null | undefined,
            approvalId: (req.body?.approval_id || req.query?.approval_id) as string | null | undefined,
            subjectId,
            approveOptions: {
              ai_training_consented: req.body?.ai_training_consented,
              ...parseBatchApproveSelection(req.body),
            },
          },
          buildConsentDecisionDeps()
        );
        if (outcome.outcome === "failure") {
          ctx.pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
          return;
        }
        if (outcome.traceContext?.request_id) {
          res.setHeader("Request-Id", outcome.traceContext.request_id);
        }
        if (outcome.traceContext?.trace_id) {
          ctx.setReferenceTraceId(res, outcome.traceContext.trace_id);
        }
        // Only the approve branch has grant + token on the outcome.
        if (outcome.action !== "approve") {
          return;
        }
        const approvedRequestUri = (req.body?.request_uri || req.query?.request_uri) as string | undefined;
        await dispatchApproveResponse(
          ctx,
          req,
          res,
          outcome.grant,
          outcome.token,
          approvedRequestUri,
          outcome.package ? { package: true, package_id: outcome.package_id } : undefined
        );
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );

  app.post(
    "/consent/deny",
    ctx.ownerAuth.requireOwnerSession as RouteArg<RouteHandler | MiddlewareFn>,
    ctx.ownerAuth.requireCsrf as RouteArg<RouteHandler | MiddlewareFn>,
    async (req: RouteRequest, res: RouteResponse): Promise<void> => {
      try {
        const subjectId = ctx.ownerAuth.enabled
          ? ctx.ownerAuth.subjectId
          : (req.body?.subject_id as string | undefined) ||
            (req.query?.subject_id as string | undefined) ||
            OWNER_AUTH_DEFAULT_SUBJECT_ID;
        const outcome = await executeAsConsentDecision(
          {
            action: "deny",
            requestUri: (req.body?.request_uri || req.query?.request_uri) as string | null | undefined,
            approvalId: (req.body?.approval_id || req.query?.approval_id) as string | null | undefined,
            subjectId,
          },
          buildConsentDecisionDeps()
        );
        if (outcome.outcome === "failure") {
          ctx.pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
          return;
        }
        if (outcome.traceContext?.request_id) {
          res.setHeader("Request-Id", outcome.traceContext.request_id);
        }
        if (outcome.traceContext?.trace_id) {
          ctx.setReferenceTraceId(res, outcome.traceContext.trace_id);
        }
        ctx.agentConnectAttemptStore.fail(
          (req.body?.request_uri || req.query?.request_uri) as string | undefined,
          "denied"
        );
        res.send(
          ctx.consentUi.renderHostedDocument({
            title: `${ctx.providerName} — Access denied`,
            providerName: ctx.providerName,
            body: [
              ctx.consentUi.renderPageIntro({
                eyebrow: "Consent result",
                title: "Access Denied",
              }),
              ctx.consentUi.renderSurface({
                children: ctx.consentUi.renderResultState({
                  tone: "danger",
                  title: "Request rejected",
                  body: "The pending data access request was rejected and cleared.",
                }),
              }),
            ].join("\n"),
          })
        );
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );

  // Reference-only redemption surface for the human-hosted approval flow.
  // The HTML branch of POST /consent/approve embeds an opaque single-use code
  // instead of the live bearer; the client (or human relaying for the client)
  // redeems the code here to receive the same JSON body the JSON branch of
  // POST /consent/approve already returns. Spec:
  //   openspec/changes/harden-consent-token-handoff/specs/
  //     reference-implementation-architecture/spec.md
  // Consent-exchange-code redemption semantics live in the canonical
  // `as.consent.exchange` operation (operations/as-consent-exchange).
  app.post(
    "/consent/exchange",
    { contract: "exchangeConsentCode" } as RouteArg<RouteHandler | MiddlewareFn>,
    async (req: RouteRequest, res: RouteResponse): Promise<void> => {
      try {
        const outcome = await executeAsConsentExchange(
          { code: typeof req.body?.code === "string" ? req.body.code : null },
          { consumeConsentExchangeCode: ctx.consumeConsentExchangeCode }
        );
        if (outcome.outcome === "success") {
          res.json(outcome.envelope);
          return;
        }
        ctx.pdppError(res, outcome.status, outcome.errorCode, outcome.errorMessage);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}
