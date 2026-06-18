// Optional live-origin probe for the owner-journey acceptance harness.
//
// When the owner supplies a live origin (and owner auth), the harness fetches
// the rendered owner setup surfaces over HTTP and runs the same forbidden-string
// rules over the served HTML. This catches a leak that only appears in the
// deployed render (e.g. a server-injected string) — without any browser
// automation; a plain authenticated fetch is enough for static-string checks.
//
// Auth is read from the environment and NEVER printed. The harness passes the
// owner session cookie or bearer through to the fetch and reports only whether
// auth was supplied, never its value.

import { FORBIDDEN_STRING_RULES } from "./surface-manifest.mjs";
import { lineOf, scanForbiddenStrings } from "./scan.mjs";

/**
 * Owner setup surfaces to probe on a live origin. Path + tier; the forbidden
 * rules for that tier are applied to the served HTML.
 */
export const LIVE_SURFACES = [
  { path: "/dashboard", tier: "normal" },
  { path: "/dashboard/connect", tier: "normal" },
  { path: "/dashboard/connect/browser-session/amazon", tier: "normal" },
  { path: "/dashboard/connect/manual-upload/google-maps", tier: "normal" },
  { path: "/dashboard/connect/manual-upload/whatsapp", tier: "normal" },
  { path: "/dashboard/records", tier: "normal" },
  { path: "/dashboard/records/add", tier: "normal" },
  { path: "/dashboard/explore", tier: "normal" },
  { path: "/dashboard/grants", tier: "normal" },
  { path: "/dashboard/traces", tier: "normal" },
  { path: "/dashboard/runs", tier: "normal" },
  { path: "/dashboard/schedules", tier: "normal" },
  { path: "/dashboard/search", tier: "normal" },
  { path: "/dashboard/device-exporters", tier: "advanced" },
];

/**
 * Resolve owner auth from the environment without exposing its value.
 * Recognized (first match wins):
 *   PDPP_OWNER_SESSION_COOKIE — full Cookie header value for an owner session.
 *   PDPP_OWNER_TOKEN          — owner bearer token.
 *
 * @returns {{ header: Record<string,string>, mode: "cookie"|"bearer"|"none" }}
 */
export function resolveOwnerAuthFromEnv(env = process.env) {
  const cookie = env.PDPP_OWNER_SESSION_COOKIE?.trim();
  if (cookie) {
    return { header: { cookie }, mode: "cookie" };
  }
  const token = env.PDPP_OWNER_TOKEN?.trim();
  if (token) {
    return { header: { authorization: `Bearer ${token}` }, mode: "bearer" };
  }
  return { header: {}, mode: "none" };
}

function setCookiePairs(res) {
  if (typeof res.headers?.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const raw = res.headers?.get?.("set-cookie");
  return raw ? [raw] : [];
}

function findCookiePair(cookies, name) {
  const prefix = `${name}=`;
  const entry = cookies.find((cookie) => cookie.startsWith(prefix));
  return entry ? entry.split(";")[0] : null;
}

function extractCsrfField(html) {
  return html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/)?.[1] ?? null;
}

async function loginWithOwnerPassword({ base, password, fetchImpl }) {
  const loginPage = await fetchImpl(`${base}/owner/login?return_to=%2Fdashboard`, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  const csrfCookie = findCookiePair(setCookiePairs(loginPage), "pdpp_owner_csrf");
  const csrfField = extractCsrfField(await loginPage.text());
  if (!(csrfCookie && csrfField)) {
    return { header: {}, mode: "password-session", error: "owner login did not return a CSRF cookie and field" };
  }

  const resp = await fetchImpl(`${base}/owner/login`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      cookie: csrfCookie,
    },
    redirect: "manual",
    body: new URLSearchParams({ password, return_to: "/dashboard", _csrf: csrfField }).toString(),
  });
  const sessionCookie = findCookiePair(setCookiePairs(resp), "pdpp_owner_session");
  if (!sessionCookie) {
    return { header: {}, mode: "password-session", error: `owner login did not issue a session cookie (status ${resp.status})` };
  }
  return { header: { cookie: sessionCookie }, mode: "password-session", error: null };
}

async function resolveOwnerAuthForLive({ base, env, fetchImpl }) {
  const cookie = env.PDPP_OWNER_SESSION_COOKIE?.trim();
  if (cookie) {
    return { header: { cookie }, mode: "cookie", error: null };
  }

  const password = env.PDPP_OWNER_PASSWORD?.trim();
  if (password) {
    return loginWithOwnerPassword({ base, password, fetchImpl });
  }

  // `_ref` owner-session routes do not generally accept owner bearer tokens on
  // the composed dashboard origin, but keep this as a best-effort fallback for
  // older/local references that did.
  const token = env.PDPP_OWNER_TOKEN?.trim();
  if (token) {
    return { header: { authorization: `Bearer ${token}` }, mode: "bearer", error: null };
  }

  return { header: {}, mode: "none", error: null };
}

function htmlToText(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToProseText(html) {
  return htmlToText(
    String(html).replace(/<(pre|code|kbd|samp)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
  );
}

function visibleMonogramInitials(html) {
  const out = [];
  const re = /<span\b([^>]*\bclass=(["'])[^"']*\bpdpp-monogram\b[^"']*\2[^>]*)>([\s\S]*?)<\/span>/gi;
  for (const match of String(html).matchAll(re)) {
    const attrs = match[1] ?? "";
    if (/\baria-hidden=(["'])true\1/i.test(attrs)) {
      continue;
    }
    const initials = htmlToText(match[3] ?? "");
    if (initials) {
      out.push(initials);
    }
  }
  return out;
}

function asArrayList(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (raw && typeof raw === "object" && Array.isArray(raw.data)) {
    return raw.data;
  }
  return [];
}

function ownerSatisfiableAction(verdict) {
  const actions = Array.isArray(verdict?.required_actions) ? verdict.required_actions : [];
  return actions.some((action) => action?.audience === "owner" && action?.satisfied_when?.kind !== "none");
}

function ownerSatisfiableActions(verdict) {
  const actions = Array.isArray(verdict?.required_actions) ? verdict.required_actions : [];
  return actions.filter((action) => action?.audience === "owner" && action?.satisfied_when?.kind !== "none");
}

function compactStrings(values) {
  return Array.from(
    new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );
}

function nextStepTextCandidates(action) {
  return compactStrings([
    action?.cta,
    action?.remediation?.label,
    action?.remediation?.summary,
    ...(Array.isArray(action?.remediation?.commands)
      ? action.remediation.commands.map((command) => command?.label)
      : []),
  ]);
}

function owesOwnerNextStepFromRaw(connector) {
  if (connector?.revoked_at) {
    return false;
  }
  const health = connector?.connection_health;
  if (health?.reason_code === "stale_manual_refresh") {
    return true;
  }
  if (health?.axes?.outbox === "stalled") {
    return true;
  }
  if (connector?.schedule?.human_attention_needed === true) {
    return true;
  }
  return false;
}

function detailHasOwnerActionVerb(text) {
  return /\b(Refresh now|Run a refresh|Recover|Retry|Reconnect|Reauthorize|Review|Set schedule|Sync now)\b/i.test(text);
}

function renderedVerdict(connector) {
  const verdict = connector?.rendered_verdict;
  return verdict && typeof verdict === "object" ? verdict : null;
}

function connectorLabel(connector) {
  return (
    connector?.display_name ||
    connector?.connector_display_name ||
    connector?.connector_id ||
    connector?.connection_id ||
    "A source"
  );
}

function sourceCountPhrase(connector) {
  const records = Number(connector?.total_records);
  const rawStreamCount = connector?.stream_count ?? (Array.isArray(connector?.streams) ? connector.streams.length : null);
  const streams = Number(rawStreamCount);
  if (!Number.isFinite(records) || !Number.isFinite(streams)) {
    return null;
  }
  const recordCount = Math.max(0, Math.floor(records));
  const streamCount = Math.max(0, Math.floor(streams));
  return `${recordCount.toLocaleString()} ${recordCount === 1 ? "record" : "records"} · ${streamCount.toLocaleString()} ${
    streamCount === 1 ? "stream" : "streams"
  }`;
}

function connectorRouteId(connector) {
  const id = connector?.connector_instance_id ?? connector?.connection_id ?? null;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function isMaterialSourceIssue(connector) {
  if (connector?.revoked_at) {
    return false;
  }
  const verdict = renderedVerdict(connector);
  if (!verdict) {
    return false;
  }
  if (verdict.channel === "attention" && ownerSatisfiableAction(verdict)) {
    return false;
  }
  const pill = verdict.pill && typeof verdict.pill === "object" ? verdict.pill : {};
  return (
    pill.tone === "red" ||
    pill.label === "Can't collect" ||
    pill.tone === "amber" ||
    pill.label === "Degraded" ||
    verdict.channel === "attention"
  );
}

function isHealthyRefreshAdvisory(connector) {
  if (connector?.revoked_at) {
    return false;
  }
  const verdict = renderedVerdict(connector);
  if (!verdict || verdict.channel !== "advisory") {
    return false;
  }
  const pill = verdict.pill && typeof verdict.pill === "object" ? verdict.pill : {};
  if (pill.tone !== "green" && pill.label !== "Healthy") {
    return false;
  }
  const actionText = Array.isArray(verdict.required_actions)
    ? verdict.required_actions.map((action) => `${action?.kind ?? ""} ${action?.cta ?? ""}`).join(" ")
    : "";
  return /\brefresh\b/i.test(`${verdict.forward_statement ?? ""} ${actionText}`);
}

function isRawMaterialSourceIssue(connector) {
  if (connector?.revoked_at) {
    return false;
  }
  const health = connector?.connection_health;
  const state = String(health?.state ?? "").toLowerCase();
  if (state === "degraded" || state === "blocked") {
    return true;
  }
  const coverage = String(health?.axes?.coverage ?? "").toLowerCase();
  if (coverage === "terminal_gap" || coverage === "retryable_gap" || coverage === "partial") {
    return true;
  }
  const outbox = String(health?.axes?.outbox ?? "").toLowerCase();
  if (outbox === "stalled") {
    return true;
  }
  const runStatus = String(connector?.last_run?.status ?? "").toLowerCase();
  return runStatus === "failed" || runStatus === "rejected";
}

function shouldProbeSourceDetailRecoveryCopy(connector) {
  if (connector?.revoked_at) {
    return false;
  }
  const verdict = renderedVerdict(connector);
  if (!verdict) {
    return false;
  }
  return isMaterialSourceIssue(connector) || verdict.channel === "attention" || ownerSatisfiableAction(verdict);
}

const SUCCESS_RUN_STATUSES = new Set(["succeeded", "success", "completed"]);

function collectionReportHasOpenGaps(report) {
  if (!Array.isArray(report)) {
    return false;
  }
  return report.some((entry) => {
    if (entry?.coverage_condition !== "complete") {
      return true;
    }
    if (Number(entry?.pending_detail_gaps ?? 0) > 0) {
      return true;
    }
    return entry?.skipped !== null && entry?.skipped !== undefined;
  });
}

function shouldProbeSourceDetailRunGapHonesty(connector) {
  if (connector?.revoked_at) {
    return false;
  }
  const lastRunStatus = String(connector?.last_run?.status ?? "").toLowerCase();
  return SUCCESS_RUN_STATUSES.has(lastRunStatus) && collectionReportHasOpenGaps(connector?.collection_report);
}

function runLiveGrantCaptionChecks({ htmlByPath }) {
  const findings = [];
  const checks = [];
  const grantsText = htmlToText(htmlByPath.get("/dashboard/grants") ?? "");
  const rawClientCaption =
    grantsText.match(/\bclient\s+cli_[a-z0-9]+\b/i)?.[0] ??
    grantsText.match(/\bclient\s+https?:\/\/[^\s]+/i)?.[0] ??
    null;

  if (rawClientCaption) {
    findings.push({
      ruleId: "grants-raw-client-caption",
      class: "dashboard-trust-claim",
      path: "live:/dashboard/grants",
      line: 0,
      excerpt: rawClientCaption,
      rationale:
        "The grants list must not lead with raw technical client ids in visible row copy. Preserve ids as details, but render registered client names or a human fallback caption.",
    });
  }

  checks.push({
    id: "grants-client-caption-humanized",
    status: rawClientCaption ? "fail" : "pass",
    detail: rawClientCaption ? "raw technical client caption visible" : "no raw technical client caption visible",
  });

  return { findings, checks };
}

async function fetchJsonOrFinding({ base, header, fetchImpl, path }) {
  try {
    const res = await fetchImpl(`${base}${path}`, {
      headers: { accept: "application/json", ...header },
      redirect: "manual",
    });
    const status = res.status;
    const body = await res.text();
    if (status < 200 || status >= 300) {
      return {
        data: null,
        finding: {
          ruleId: "live-ref-surface-not-reached",
          class: "live-probe-inconclusive",
          path: `live:${path}`,
          line: 0,
          excerpt: `status ${status}`,
          rationale:
            "The live semantic probe could not reach the reference JSON surface. Owner-journey trust checks are inconclusive until the data source behind the rendered page is observed.",
        },
      };
    }
    return { data: JSON.parse(body), finding: null };
  } catch (err) {
    return {
      data: null,
      finding: {
        ruleId: "live-ref-surface-fetch-failed",
        class: "live-probe-inconclusive",
        path: `live:${path}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "The live semantic probe could not fetch or parse the reference JSON surface. Owner-journey trust checks are inconclusive until the rendered page can be compared with its source data.",
      },
    };
  }
}

async function runLiveSemanticChecks({ base, header, fetchImpl, htmlByPath }) {
  const findings = [];
  const checks = [];

  const connectorsResult = await fetchJsonOrFinding({
    base,
    header,
    fetchImpl,
    path: "/_ref/connectors?limit=200",
  });
  if (connectorsResult.finding) {
    findings.push(connectorsResult.finding);
    checks.push({
      id: "dashboard-source-issue-all-clear",
      status: "inconclusive",
      detail: "connectors JSON unavailable",
    });
    return { findings, checks };
  }

  const connectors = asArrayList(connectorsResult.data);
  const sourceIssues = connectors.filter(isMaterialSourceIssue).map((connector) => ({
    label: connectorLabel(connector),
    forwardStatement: String(renderedVerdict(connector)?.forward_statement ?? ""),
  }));
  const healthyRefreshAdvisories = connectors.filter(isHealthyRefreshAdvisory).map((connector) => ({
    label: connectorLabel(connector),
    forwardStatement: String(renderedVerdict(connector)?.forward_statement ?? ""),
  }));
  const rawSourceIssues = connectors.filter(isRawMaterialSourceIssue).map((connector) => ({
    label: connectorLabel(connector),
    reason: connector?.connection_health?.reason_code ?? connector?.last_run?.failure_reason ?? "raw source issue",
  }));
  const dashboardText = htmlToText(htmlByPath.get("/dashboard") ?? "");
  const dashboardVisibleMonograms = visibleMonogramInitials(htmlByPath.get("/dashboard") ?? "");
  const unsupportedAllClearClaim =
    dashboardText.match(/\bGrants are within their limits\b/i)?.[0] ??
    dashboardText.match(/\bbackups are on\b/i)?.[0] ??
    null;
  if (unsupportedAllClearClaim) {
    findings.push({
      ruleId: "dashboard-unsupported-all-clear-claim",
      class: "dashboard-trust-claim",
      path: "live:/dashboard",
      line: 0,
      excerpt: unsupportedAllClearClaim,
      rationale:
        "The dashboard all-clear must only state facts backed by the overview inputs. It must not claim backup state or grant-limit health unless those facts are actually derived.",
    });
  }
  if (dashboardVisibleMonograms.length > 0) {
    findings.push({
      ruleId: "dashboard-monogram-not-decorative",
      class: "dashboard-accessibility",
      path: "live:/dashboard",
      line: 0,
      excerpt: dashboardVisibleMonograms.slice(0, 5).join(", "),
      rationale:
        "Dashboard client monograms are visual marks. If their initials remain in the text/accessibility tree, owner-facing labels collapse into strings like CLCLaude instead of Claude.",
    });
  }

  if (sourceIssues.length > 0 || rawSourceIssues.length > 0) {
    const allClearRe = /No source issues to review here|Nothing needs you\.[^.]*sources are syncing\.|everything'?s syncing/i;
    if (allClearRe.test(dashboardText)) {
      findings.push({
        ruleId: "dashboard-source-issue-all-clear",
        class: "dashboard-trust-claim",
        path: "live:/dashboard",
        line: 0,
        excerpt: dashboardText.match(allClearRe)?.[0] ?? "all-clear copy",
        rationale:
          "The dashboard must not claim sources are syncing when the reference connector summary contains material non-owner source issues. The hero may stay calm, but the Anything wrong panel must disclose the issue.",
      });
    }
  }

  const overstatedHealthyAdvisories = healthyRefreshAdvisories.filter((issue) => {
    const renderedAsBroken = dashboardText.includes(`${issue.label} is degraded`) || dashboardText.includes(`${issue.label} can't collect`);
    const renderedWithRefreshStatement =
      issue.forwardStatement.length > 0 && dashboardText.includes(issue.label) && dashboardText.includes(issue.forwardStatement);
    return renderedAsBroken || renderedWithRefreshStatement;
  });
  if (overstatedHealthyAdvisories.length > 0) {
    findings.push({
      ruleId: "dashboard-healthy-advisory-overstated",
      class: "dashboard-trust-claim",
      path: "live:/dashboard",
      line: 0,
      excerpt: overstatedHealthyAdvisories.map((issue) => issue.label).slice(0, 5).join(", "),
      rationale:
        "A healthy source with a refresh-available advisory must not appear in the dashboard issue list as degraded or broken. The source detail may offer Refresh now, but the dashboard must not manufacture urgency.",
    });
  }

  if (sourceIssues.length > 0) {
    const representedIssue = sourceIssues.some((issue) => dashboardText.includes(issue.label));
    if (!representedIssue) {
      findings.push({
        ruleId: "dashboard-source-issue-missing",
        class: "dashboard-trust-claim",
        path: "live:/dashboard",
        line: 0,
        excerpt: sourceIssues.map((issue) => issue.label).slice(0, 5).join(", "),
        rationale:
          "The dashboard reference data contains material source issues, but none of their source labels appear on the rendered dashboard. The owner needs a visible issue row, not a silent calm state.",
      });
    }
  }

  if (rawSourceIssues.length > 0) {
    const representedRawIssue = rawSourceIssues.some((issue) => dashboardText.includes(issue.label));
    if (!representedRawIssue) {
      findings.push({
        ruleId: "dashboard-raw-source-issue-missing",
        class: "dashboard-trust-claim",
        path: "live:/dashboard",
        line: 0,
        excerpt: rawSourceIssues
          .map((issue) => `${issue.label}:${issue.reason}`)
          .slice(0, 5)
          .join(", "),
        rationale:
          "Raw connection-health evidence contains a material source issue, but none of those source labels appear on the rendered dashboard. The dashboard must disclose broken-source facts even if a rendered verdict projection regresses.",
      });
    }
  }

  checks.push({
    id: "dashboard-source-issue-all-clear",
    status: findings.some(
      (f) =>
        f.ruleId === "dashboard-source-issue-all-clear" ||
        f.ruleId === "dashboard-source-issue-missing" ||
        f.ruleId === "dashboard-raw-source-issue-missing" ||
        f.ruleId === "dashboard-healthy-advisory-overstated" ||
        f.ruleId === "dashboard-unsupported-all-clear-claim"
    )
      ? "fail"
      : "pass",
    detail: `${sourceIssues.length} rendered material source issue(s), ${rawSourceIssues.length} raw material source issue(s) in /_ref/connectors`,
  });
  checks.push({
    id: "dashboard-decorative-monograms",
    status: dashboardVisibleMonograms.length > 0 ? "fail" : "pass",
    detail:
      dashboardVisibleMonograms.length > 0
        ? `${dashboardVisibleMonograms.length} visible monogram initial(s) leaked into dashboard text`
        : "dashboard monogram initials are decorative",
  });

  const browserSessionPath = "/dashboard/connect/browser-session/amazon";
  const browserSessionHtml = htmlByPath.get(browserSessionPath) ?? "";
  const browserSessionText = htmlToText(browserSessionHtml);
  const exposesDirectNewBrowserSource =
    /\bStart session\b/i.test(browserSessionText) &&
    /\/dashboard\/connect\/browser-session\/amazon\/start/.test(browserSessionHtml);
  if (exposesDirectNewBrowserSource) {
    findings.push({
      ruleId: "browser-session-direct-new-source",
      class: "dashboard-setup-integrity",
      path: `live:${browserSessionPath}`,
      line: 0,
      excerpt: "Start session",
      rationale:
        "A direct browser-session setup URL must not expose a new-source start control. Without an explicit add-another flow, it can silently create duplicate unnamed browser-backed sources.",
    });
  }
  checks.push({
    id: "browser-session-direct-new-source",
    status: exposesDirectNewBrowserSource ? "fail" : "pass",
    detail: exposesDirectNewBrowserSource
      ? "direct browser-session page can start a new source"
      : "direct browser-session page does not expose a new-source start control",
  });

  const contentExpectations = [
    {
      id: "schedules-content-rendered",
      path: "/dashboard/schedules",
      title: "Schedules",
      required: [
        { label: "Schedules title", pattern: /\bSchedules\b/i },
        { label: "schedule section", pattern: /\bScheduled connections\b|\bNo scheduled connections yet\b/i },
        { label: "scheduled/unscheduled counts", pattern: /\bscheduled\b.*\bunscheduled\b/i },
      ],
    },
    {
      id: "explore-content-rendered",
      path: "/dashboard/explore",
      title: "Explore",
      required: [
        { label: "Explore title", pattern: /\bExplore\b/i },
        { label: "record query controls", pattern: /Search names, fields, and values|Search records|text across every searchable stream|\boperators\b.*\bcon:/i },
        { label: "record filters", pattern: /\bFilters\b/i },
        { label: "record sort controls", pattern: /\bnewest\b.*\boldest\b/i },
      ],
    },
  ];
  for (const expectation of contentExpectations) {
    const pageText = htmlToText(htmlByPath.get(expectation.path) ?? "");
    const missing = expectation.required.filter((item) => !item.pattern.test(pageText));
    if (missing.length > 0) {
      findings.push({
        ruleId: expectation.id,
        class: "dashboard-content-missing",
        path: `live:${expectation.path}`,
        line: 0,
        excerpt: missing.map((item) => item.label).join(", "),
        rationale:
          `${expectation.title} must render its core owner controls on the live surface. A shell-only, login, or error-boundary page cannot prove the owner can use this journey.`,
      });
    }
    checks.push({
      id: expectation.id,
      status: missing.length > 0 ? "fail" : "pass",
      detail: missing.length > 0
        ? `missing ${missing.map((item) => item.label).join(", ")}`
        : `${expectation.title} rendered core owner controls`,
    });
  }

  const recordsText = htmlToText(htmlByPath.get("/dashboard/records") ?? "");
  const recordsCountFindings = [];
  let checkedSourceCounts = 0;
  for (const connector of connectors) {
    if (connector?.revoked_at) {
      continue;
    }
    const label = connectorLabel(connector);
    if (!recordsText.includes(label)) {
      continue;
    }
    const expectedCountPhrase = sourceCountPhrase(connector);
    if (!expectedCountPhrase) {
      continue;
    }
    checkedSourceCounts += 1;
    if (!recordsText.includes(expectedCountPhrase)) {
      const finding = {
        ruleId: "records-source-count-mismatch",
        class: "dashboard-data-claim",
        path: "live:/dashboard/records",
        line: 0,
        excerpt: `${label} expected ${expectedCountPhrase}`,
        rationale:
          "The Sources page must render source record and stream counts that match the reference connector summary. Wrong visible counts break the owner's ability to know what data they have.",
      };
      recordsCountFindings.push(finding);
      findings.push(finding);
    }
  }
  if (connectors.length > 0 && checkedSourceCounts === 0 && /\bSources\b/i.test(recordsText)) {
    const finding = {
      ruleId: "records-source-counts-missing",
      class: "dashboard-data-claim",
      path: "live:/dashboard/records",
      line: 0,
      excerpt: "no configured source labels with counts found",
      rationale:
        "The Sources page looked like the owner source list but none of the configured source labels from the reference summary appeared with counts. The owner cannot verify what data they have.",
    };
    recordsCountFindings.push(finding);
    findings.push(finding);
  }
  checks.push({
    id: "records-counts-match-reality",
    status: recordsCountFindings.length > 0 ? "fail" : "pass",
    detail:
      checkedSourceCounts === 0
        ? "no rendered configured source count claims to compare"
        : `${checkedSourceCounts} rendered source count claim(s) matched /_ref/connectors`,
  });

  const nextActionFindings = [];
  const nextActionConnectors = connectors
    .filter((connector) => !connector?.revoked_at)
    .map((connector) => {
      const verdict = renderedVerdict(connector);
      const actions = ownerSatisfiableActions(verdict);
      const textCandidates = actions.flatMap(nextStepTextCandidates);
      return {
        actions,
        connector,
        label: connectorLabel(connector),
        routeId: connectorRouteId(connector),
        textCandidates,
        verdict,
      };
    })
    .filter((entry) => entry.routeId && entry.textCandidates.length > 0);

  for (const entry of nextActionConnectors) {
    if (entry.verdict?.channel === "attention") {
      const dashboardHasSource = dashboardText.includes(entry.label);
      const dashboardHasAction = ["See what to do", "See recovery steps", ...entry.textCandidates].some((candidate) =>
        dashboardText.includes(candidate)
      );
      if (!dashboardHasSource || !dashboardHasAction) {
        const finding = {
          ruleId: "dashboard-next-action-missing",
          class: "source-next-action",
          path: "live:/dashboard",
          line: 0,
          excerpt: `${entry.label}: ${entry.textCandidates[0]}`,
          rationale:
            "When the reference connector summary says an owner-satisfiable attention action exists, the dashboard must point the owner to that exact source and next step instead of leaving the action discoverable only by spelunking.",
        };
        nextActionFindings.push(finding);
        findings.push(finding);
      }
    }

    const path = `/dashboard/records/${encodeURIComponent(entry.routeId)}`;
    try {
      const res = await fetchImpl(`${base}${path}`, {
        headers: { accept: "text/html", ...header },
        redirect: "manual",
      });
      const status = res.status;
      const html = await res.text();
      if (status < 200 || status >= 300) {
        const finding = {
          ruleId: "source-next-action-detail-not-reached",
          class: "source-next-action",
          path: `live:${path}`,
          line: 0,
          excerpt: `status ${status}`,
          rationale:
            "The live probe could not reach the exact source detail route for an owner-satisfiable action. The owner cannot know what to do next if the action destination does not render.",
        };
        nextActionFindings.push(finding);
        findings.push(finding);
        continue;
      }
      const detailText = htmlToText(html);
      const detailHasAction = entry.textCandidates.some((candidate) => detailText.includes(candidate));
      if (!detailHasAction) {
        const finding = {
          ruleId: "source-next-action-copy-missing",
          class: "source-next-action",
          path: `live:${path}`,
          line: 0,
          excerpt: `${entry.label}: ${entry.textCandidates[0]}`,
          rationale:
            "The exact source detail route must render the owner-facing action from the reference verdict. A hidden or missing action breaks the owner's ability to decide the next step.",
        };
        nextActionFindings.push(finding);
        findings.push(finding);
      }
    } catch (err) {
      const finding = {
        ruleId: "source-next-action-detail-fetch-failed",
        class: "source-next-action",
        path: `live:${path}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "The live probe could not fetch the exact source detail route for an owner-satisfiable action. The owner next-step check is inconclusive until the route is observable.",
      };
      nextActionFindings.push(finding);
      findings.push(finding);
    }
  }

  const rawNextStepConnectors = connectors
    .filter(owesOwnerNextStepFromRaw)
    .map((connector) => ({
      connector,
      label: connectorLabel(connector),
      routeId: connectorRouteId(connector),
    }))
    .filter((entry) => entry.routeId);

  for (const entry of rawNextStepConnectors) {
    const path = `/dashboard/records/${encodeURIComponent(entry.routeId)}`;
    try {
      const res = await fetchImpl(`${base}${path}`, {
        headers: { accept: "text/html", ...header },
        redirect: "manual",
      });
      const status = res.status;
      const html = await res.text();
      if (status < 200 || status >= 300) {
        const finding = {
          ruleId: "raw-next-action-detail-not-reached",
          class: "source-next-action",
          path: `live:${path}`,
          line: 0,
          excerpt: `status ${status}`,
          rationale:
            "Raw connection evidence says this source needs an owner next step, but the exact source route did not render. The owner cannot know what to do next from a dead destination.",
        };
        nextActionFindings.push(finding);
        findings.push(finding);
        continue;
      }
      const detailText = htmlToText(html);
      if (!detailHasOwnerActionVerb(detailText)) {
        const finding = {
          ruleId: "raw-next-action-affordance-missing",
          class: "source-next-action",
          path: `live:${path}`,
          line: 0,
          excerpt: entry.label,
          rationale:
            "Raw connection evidence says this source needs an owner next step, but the exact source route did not render an owner-actionable verb such as Refresh now, Recover, Retry, or Reconnect.",
        };
        nextActionFindings.push(finding);
        findings.push(finding);
      }
    } catch (err) {
      const finding = {
        ruleId: "raw-next-action-detail-fetch-failed",
        class: "source-next-action",
        path: `live:${path}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "The live probe could not fetch the exact source route for a raw owner next-step condition. The owner next-step check is inconclusive until the route is observable.",
      };
      nextActionFindings.push(finding);
      findings.push(finding);
    }
  }
  checks.push({
    id: "whats-next-actionable",
    status: nextActionFindings.length > 0 ? "fail" : "pass",
    detail:
      nextActionConnectors.length === 0 && rawNextStepConnectors.length === 0
        ? "no rendered or raw owner next-step conditions to probe"
        : `${nextActionConnectors.length} rendered action route(s) and ${rawNextStepConnectors.length} raw owner next-step route(s) rendered their next step`,
  });

  const singleTokenDenialCodes = new Set([
    "blocked",
    "captcha",
    "consumed",
    "denied",
    "disabled",
    "expired",
    "forbidden",
    "revoked",
    "unauthorized",
    "unknown",
  ]);
  const rawDenialReasonCandidate =
    dashboardText.match(/turned away,\s+([a-z][a-z0-9_]*)\b/i)?.[1]?.toLowerCase() ?? null;
  const rawDenialReason =
    rawDenialReasonCandidate &&
    (rawDenialReasonCandidate.includes("_") || singleTokenDenialCodes.has(rawDenialReasonCandidate))
      ? rawDenialReasonCandidate
      : null;
  if (rawDenialReason) {
    findings.push({
      ruleId: "dashboard-raw-denial-reason",
      class: "dashboard-trust-claim",
      path: "live:/dashboard",
      line: 0,
      excerpt: rawDenialReason,
      rationale:
        "The dashboard's recent-read summary must not render raw diagnostic denial reason codes. Overview copy should explain the denial in owner language and leave exact codes to trace detail surfaces.",
    });
  }
  checks.push({
    id: "dashboard-denial-reasons-humanized",
    status: rawDenialReason ? "fail" : "pass",
    detail: rawDenialReason ? `raw denial reason visible: ${rawDenialReason}` : "no raw denial reason visible",
  });

  const recoveryRouteIds = Array.from(
    new Set(
      connectors
        .filter(shouldProbeSourceDetailRecoveryCopy)
        .map(connectorRouteId)
        .filter((id) => typeof id === "string" && id.length > 0)
    )
  ).slice(0, 12);
  const rawRecoveryTermFindings = [];
  for (const routeId of recoveryRouteIds) {
    try {
      const path = `/dashboard/records/${encodeURIComponent(routeId)}`;
      const res = await fetchImpl(`${base}${path}`, {
        headers: { accept: "text/html", ...header },
        redirect: "manual",
      });
      const status = res.status;
      const html = await res.text();
      if (status < 200 || status >= 300) {
        findings.push({
          ruleId: "source-detail-not-reached",
          class: "live-probe-inconclusive",
          path: `live:${path}`,
          line: 0,
          excerpt: `status ${status}`,
          rationale:
            "The live semantic probe could not reach a source recovery detail page. Owner recovery copy is inconclusive until the exact source route renders.",
        });
        continue;
      }
      const detailText = htmlToProseText(html);
      const rawRecoveryTerm = detailText.match(/\bdead-letter(?:ed)?\b/i)?.[0] ?? null;
      if (rawRecoveryTerm) {
        const finding = {
          ruleId: "source-detail-raw-recovery-jargon",
          class: "source-recovery-copy",
          path: `live:${path}`,
          line: 0,
          excerpt: rawRecoveryTerm,
          rationale:
            "Owner-facing recovery copy must not use durable-outbox jargon such as dead-letter. Use owner-language like failed uploads while preserving exact technical terms only in commands or engineering traces.",
        };
        rawRecoveryTermFindings.push(finding);
        findings.push(finding);
      }
    } catch (err) {
      findings.push({
        ruleId: "source-detail-fetch-failed",
        class: "live-probe-inconclusive",
        path: `live:/dashboard/records/${routeId}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "The live semantic probe could not fetch a source recovery detail page. Owner recovery copy is inconclusive until the exact source route renders.",
      });
    }
  }
  checks.push({
    id: "source-detail-recovery-copy-humanized",
    status: rawRecoveryTermFindings.length > 0 ? "fail" : "pass",
    detail:
      recoveryRouteIds.length === 0
        ? "no source recovery detail routes to probe"
        : rawRecoveryTermFindings.length > 0
          ? `${rawRecoveryTermFindings.length} detail page(s) render raw recovery jargon`
          : `${recoveryRouteIds.length} source recovery detail route(s) render human recovery copy`,
  });

  const runGapRouteIds = Array.from(
    new Set(
      connectors
        .filter(shouldProbeSourceDetailRunGapHonesty)
        .map(connectorRouteId)
        .filter((id) => typeof id === "string" && id.length > 0)
    )
  ).slice(0, 12);
  const runGapFindings = [];
  for (const routeId of runGapRouteIds) {
    try {
      const path = `/dashboard/records/${encodeURIComponent(routeId)}`;
      const res = await fetchImpl(`${base}${path}`, {
        headers: { accept: "text/html", ...header },
        redirect: "manual",
      });
      const status = res.status;
      const html = await res.text();
      if (status < 200 || status >= 300) {
        findings.push({
          ruleId: "source-detail-run-gap-not-reached",
          class: "live-probe-inconclusive",
          path: `live:${path}`,
          line: 0,
          excerpt: `status ${status}`,
          rationale:
            "The live semantic probe could not reach a source detail page that has a successful latest run with unresolved collection gaps. Run-status honesty is inconclusive until the exact source route renders.",
        });
        continue;
      }
      const detailText = htmlToText(html);
      const cleanSuccessClaim = detailText.match(/\b0 failures\s*·\s*Open runs\b/i)?.[0] ?? null;
      const rendersGapStatus = /\bwith gaps\b/i.test(detailText) || /\bpartial\b/i.test(detailText);
      if (cleanSuccessClaim || !rendersGapStatus) {
        const finding = {
          ruleId: "source-detail-clean-success-with-open-gaps",
          class: "source-run-honesty",
          path: `live:${path}`,
          line: 0,
          excerpt: cleanSuccessClaim ?? "missing partial/with gaps status",
          rationale:
            "A source detail page whose latest successful run has unresolved collection gaps must not render as a clean success. It must show a partial/with-gaps status so the owner can trust the run summary.",
        };
        runGapFindings.push(finding);
        findings.push(finding);
      }
    } catch (err) {
      findings.push({
        ruleId: "source-detail-run-gap-fetch-failed",
        class: "live-probe-inconclusive",
        path: `live:/dashboard/records/${routeId}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "The live semantic probe could not fetch a source detail page with unresolved collection gaps. Run-status honesty is inconclusive until the exact source route renders.",
      });
    }
  }
  checks.push({
    id: "source-detail-run-gap-honesty",
    status: runGapFindings.length > 0 ? "fail" : "pass",
    detail:
      runGapRouteIds.length === 0
        ? "no successful source runs with unresolved gaps to probe"
        : runGapFindings.length > 0
          ? `${runGapFindings.length} detail page(s) render clean success despite open gaps`
          : `${runGapRouteIds.length} source detail route(s) render partial/with-gaps status`,
  });
  return { findings, checks };
}

/**
 * Fetch and scan the live owner surfaces. Network and auth failures are captured
 * as surface-level errors, not thrown, so the harness can still emit a report.
 *
 * @param {object} args
 * @param {string} args.origin   e.g. https://pdpp.example.com (no trailing slash required)
 * @param {object} [args.env]    defaults to process.env
 * @param {Function} [args.fetchImpl] injectable for tests; defaults to global fetch
 * @returns {Promise<{ origin:string, authMode:string, surfaces:Array, findings:Array, ok:boolean }>}
 */
export async function runLiveAcceptance({ origin, env = process.env, fetchImpl = fetch }) {
  const base = origin.replace(/\/+$/, "");
  const { header, mode, error: authError } = await resolveOwnerAuthForLive({ base, env, fetchImpl });
  const findings = [];
  const surfaces = [];
  const htmlByPath = new Map();

  if (authError) {
    findings.push({
      ruleId: "live-owner-auth-failed",
      class: "live-probe-inconclusive",
      path: "live:owner-auth",
      line: 0,
      excerpt: authError,
      rationale:
        "The live acceptance gate must inspect authenticated owner renders. Login/auth failure makes the live probe inconclusive, not passing.",
    });
  }

  for (const surface of LIVE_SURFACES) {
    const url = `${base}${surface.path}`;
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "text/html", ...header },
        redirect: "manual",
      });
      const status = res.status;
      const html = await res.text();
      // A login redirect / 401 means the probe could not see the owner surface;
      // record it as inconclusive rather than a pass.
      const reachedOwnerSurface = status >= 200 && status < 300;
      const surfaceFindings = reachedOwnerSurface
        ? scanForbiddenStrings({
            path: `live:${surface.path}`,
            src: html,
            tier: surface.tier,
            rules: FORBIDDEN_STRING_RULES,
          }).map((f) => ({ ...f, live: true, line: f.line || lineOf(html, 0) }))
        : [];
      if (reachedOwnerSurface) {
        htmlByPath.set(surface.path, html);
      }
      findings.push(...surfaceFindings);
      if (!reachedOwnerSurface) {
        findings.push({
          ruleId: "live-owner-surface-not-reached",
          class: "live-probe-inconclusive",
          path: `live:${surface.path}`,
          line: 0,
          excerpt: `status ${status}`,
          rationale:
            "The live probe did not reach the authenticated owner surface. A login redirect, 401, 404, or server error cannot prove the rendered journey is clean.",
        });
      }
      surfaces.push({
        path: surface.path,
        tier: surface.tier,
        status,
        reachedOwnerSurface,
        bytes: html.length,
        findingCount: surfaceFindings.length,
      });
    } catch (err) {
      surfaces.push({
        path: surface.path,
        tier: surface.tier,
        status: null,
        reachedOwnerSurface: false,
        error: err instanceof Error ? err.message : String(err),
      });
      findings.push({
        ruleId: "live-owner-surface-fetch-failed",
        class: "live-probe-inconclusive",
        path: `live:${surface.path}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "The live probe could not fetch the owner surface. Network or runtime failures are acceptance failures until the rendered journey is observed.",
      });
    }
  }

  const semantic = await runLiveSemanticChecks({ base, header, fetchImpl, htmlByPath });
  const grantCaptions = runLiveGrantCaptionChecks({ htmlByPath });
  findings.push(...semantic.findings);
  findings.push(...grantCaptions.findings);

  return {
    origin: base,
    authMode: mode,
    surfaces,
    semanticChecks: [...semantic.checks, ...grantCaptions.checks],
    findings,
    ok: findings.length === 0,
  };
}
