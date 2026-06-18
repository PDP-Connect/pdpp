#!/usr/bin/env node
// Tests for the owner-journey acceptance harness.
//
// Two layers:
//   1. Failure-class units — synthetic source fixtures prove every required
//      failure class is caught, and clean fixtures pass. This is the contract:
//      the harness would have caught the exact failures from the owner
//      walkthrough.
//   2. Current-pages-pass — the harness scans the REAL owner UI source and the
//      REAL package command surface and asserts both are clean. This pins the
//      live pages (and the Phase 0 + shell.tsx fixes) so a regression that
//      reintroduces a developer-only path or an unpublished command fails CI.
//
// Run: node --test scripts/check-owner-journey-acceptance.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCommandFreshness,
  checkDashboardRouteShellContract,
  checkHelpLinkTargets,
  checkPostSubmitDurability,
  checkSharedShellNavContract,
  deriveSpecifierVars,
  deriveSubcommandSurface,
  extractRenderedCommands,
  parseCommand,
  scanForbiddenStrings,
  scanRenderedHelperReachability,
  stripComments,
} from "./owner-journey-acceptance/scan.mjs";
import {
  FORBIDDEN_RENDERED_HELPERS,
  FORBIDDEN_STRING_RULES,
  POST_SUBMIT_RULE,
  PUBLISHED_PACKAGES,
} from "./owner-journey-acceptance/surface-manifest.mjs";
import { derivePublishedCommandSurface, runLocalAcceptance } from "./owner-journey-acceptance/harness.mjs";
import { renderReport } from "./owner-journey-acceptance/report.mjs";
import { resolveOwnerAuthFromEnv, runLiveAcceptance } from "./owner-journey-acceptance/live.mjs";
import { checkCleanShellFreshness } from "./owner-journey-acceptance/clean-shell.mjs";

// ── helpers ─────────────────────────────────────────────────────────────────

function scanNormal(src) {
  return scanForbiddenStrings({ path: "fixture.tsx", src, tier: "normal", rules: FORBIDDEN_STRING_RULES });
}
function classes(findings) {
  return new Set(findings.map((f) => f.class));
}

function defaultLiveOwnerPageHtml(url) {
  const href = String(url);
  if (href.endsWith("/dashboard/schedules")) {
    return "<main><h1>Schedules</h1><p>0 scheduled · 3 unscheduled</p><section>Scheduled connections (0)</section><section>No scheduled connections yet</section></main>";
  }
  if (href.endsWith("/dashboard/explore")) {
    return "<main><h1>Explore</h1><label>Search names, fields, and values — or type an operator</label><details><summary>Filters</summary></details><button>newest</button><button>oldest</button></main>";
  }
  return "<main>clean owner page</main>";
}

// ── 1. Failure-class units: forbidden strings ────────────────────────────────

test("catches monorepo package path in normal owner UI", () => {
  const src = `export function X() { return <pre>{"PDPP_DB_PATH=packages/polyfill-connectors/.pdpp-data/pdpp.sqlite"}</pre>; }`;
  assert.ok(classes(scanNormal(src)).has("developer-only-path"));
});

test("catches `pnpm --dir` in normal owner UI", () => {
  const src = `const cmd = "pnpm --dir packages/polyfill-connectors exec tsx bin/x.ts run";`;
  const found = scanNormal(src);
  assert.ok(found.some((f) => f.ruleId === "pnpm-dir"));
});

test("catches `PDPP monorepo checkout` phrasing", () => {
  const src = `const help = "Run this from your PDPP monorepo checkout.";`;
  assert.ok(found(src, "monorepo-checkout"));
});

test("catches source-tree node server start command", () => {
  const src = `const cmd = "node reference-implementation/server/index.js";`;
  assert.ok(found(src, "source-tree-node-server"));
});

test('catches "replace placeholders" copy', () => {
  const src = `const note = "Replace the placeholder with your connector_instance_id.";`;
  assert.ok(found(src, "replace-placeholders"));
});

test('catches "env var per account" jargon', () => {
  const src = `const note = "You need one env var per account in your deployment.";`;
  assert.ok(found(src, "env-var-per-account"));
});

test("catches raw setup-planner labels rendered as owner status", () => {
  for (const label of ["Track only", "Manual setup", "Ready with provider secret", "Needs browser proof"]) {
    const src = `const status = { label: "${label}" };`;
    assert.ok(found(src, "raw-setup-planner-label"), `expected to catch "${label}"`);
  }
});

test("catches raw support-state enum value rendered as text", () => {
  // Rendered text form `>proof_gated<` must trip the rule.
  const rendered = `<span>proof_gated</span>`;
  assert.ok(found(rendered, "raw-support-state-token"));
});

test("does NOT flag a setup-planner enum used in a switch/comparison (not rendered text)", () => {
  const src = `switch (entry.disposition) { case "browser_bound_runbook": return label; }
    if (entry.supportState === "proof_gated") { return x; }`;
  const found = scanNormal(src);
  assert.equal(
    found.filter((f) => f.ruleId === "raw-support-state-token").length,
    0,
    "enum in code logic must not trip the rendered-text rule"
  );
});

test("does NOT flag a monorepo path that appears only in a code comment", () => {
  const src = `// The old proof command ran under packages/polyfill-connectors with pnpm --dir.
    export function X() { return <div>Browser setup is pending.</div>; }`;
  const found = scanNormal(src);
  assert.equal(found.length, 0, "comments are not owner-facing copy");
});

test("does NOT flag a monorepo path that appears only in an import specifier", () => {
  const src = `import { x } from "../../../../packages/cli/src/package-info.js";
    export function X() { return <div>ok</div>; }`;
  const found = scanNormal(src);
  assert.equal(found.length, 0, "module specifiers are not owner-facing copy");
});

test("clean owner UI fixture passes the forbidden-string scan", () => {
  const src = `export function AddCard() {
    return <div><span>Add account</span><p>Enter the required provider credential.</p></div>;
  }`;
  assert.deepEqual(scanNormal(src), []);
});

// ── 2. Failure-class units: command freshness ────────────────────────────────

test("derives subcommand surface from `command === 'x'` dispatch", () => {
  const src = `if (command === 'connect') {} if (command === 'token') {}`;
  const surface = deriveSubcommandSurface(src);
  assert.ok(surface.has("connect") && surface.has("token"));
});

test("derives subcommand surface from a pipe-alternation usage line, ignoring placeholder args", () => {
  const src = `usage: pdpp-local-collector <enroll|run|status|doctor> --base-url <url>`;
  const surface = deriveSubcommandSurface(src);
  assert.ok(surface.has("enroll") && surface.has("doctor"));
  assert.ok(!surface.has("url"), "single <url> placeholder is not a subcommand");
});

test("flags an unpublished CLI command rendered in owner UI", () => {
  const commands = [{ head: "npx", packageName: "@pdpp/cli", subcommand: "owner-agent-explain", path: "p", line: 1, raw: "..." }];
  const surfaceByPackage = { "@pdpp/cli": new Set(["connect", "token"]) };
  const { findings } = checkCommandFreshness({ commands, surfaceByPackage, publishedPackages: PUBLISHED_PACKAGES });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "unpublished-command");
});

test("passes a published CLI command rendered in owner UI", () => {
  const commands = [{ head: "npx", packageName: "@pdpp/cli", subcommand: "connect", path: "p", line: 1, raw: "..." }];
  const surfaceByPackage = { "@pdpp/cli": new Set(["connect", "token"]) };
  const { findings, rendered } = checkCommandFreshness({
    commands,
    surfaceByPackage,
    publishedPackages: PUBLISHED_PACKAGES,
  });
  assert.equal(findings.length, 0);
  assert.equal(rendered[0].verified, "published-subcommand");
  assert.ok(rendered[0].verificationMode, "every rendered package command carries a verification mode");
});

test("resolves package-specifier variables in array-form command builders", () => {
  const src = `const localCollectorPackageName = "@pdpp/local-collector";
    const localCollectorPackageSpecifier = \`\${localCollectorPackageName}@latest\`;
    const parts = ["npx", "-y", localCollectorPackageSpecifier, "enroll", "--base-url"];`;
  const vars = deriveSpecifierVars(src);
  assert.equal(vars.localCollectorPackageSpecifier, "@pdpp/local-collector@latest");
  const cmds = extractRenderedCommands(src);
  const enroll = cmds.find((c) => c.subcommand === "enroll");
  assert.ok(enroll, "array-form npx command must be extracted");
  assert.equal(enroll.packageName, "@pdpp/local-collector");
});

// ── 3. Failure-class units: help links + reachability + post-submit ──────────

test("flags a same-tab static-secret help link", () => {
  const src = `<a href={field.help_url}>Open provider setup page</a>`;
  const findings = checkHelpLinkTargets({ path: "p", src });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "help-link-same-tab");
});

test("passes a help link that opens in a new tab with safe rel", () => {
  const src = `<a href={field.help_url} target="_blank" rel="noreferrer">Open provider setup page in a new tab</a>`;
  assert.deepEqual(checkHelpLinkTargets({ path: "p", src }), []);
});

test("reachability guard flags a rendered page wiring a monorepo-command helper", () => {
  const src = `import { pdppBrowserCollectorRunCommand } from "x";
    export function Card(){ return <code>{pdppBrowserCollectorRunCommand({baseUrl, connectorId})}</code>; }`;
  const findings = scanRenderedHelperReachability({ path: "p", src, forbiddenHelpers: FORBIDDEN_RENDERED_HELPERS });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, "developer-only-path");
});

test("post-submit durability flags a transient-only flow and passes a durable one", () => {
  const transient = `const notice = "Submitted. Check connections later.";`;
  const missing = checkPostSubmitDurability({ path: "p", src: transient, rule: POST_SUBMIT_RULE });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].class, "transient-notice-only");

  const durable = `const c = draft.connection_id; const r = statusHref({ connectionId: c }); redirect(r);`;
  assert.deepEqual(checkPostSubmitDurability({ path: "p", src: durable, rule: POST_SUBMIT_RULE }), []);
});

test("shared shell nav contract catches missing route links and ambiguous Explore chrome", () => {
  const src = `export const NAV_GROUPS = [
    { heading: null, items: [{ label: "Sources", href: "/dashboard/records" }] },
  ];
  function NavList(){ return <button>{item.label}</button>; }
  export function RecordroomShell(){ return <button className="rr-chrome-btn">Explore</button>; }`;
  const findings = checkSharedShellNavContract({
    path: "shell.tsx",
    src,
    requiredItems: [{ label: "Explore", href: "/dashboard/explore" }],
  });
  assert.ok(findings.some((f) => f.ruleId === "shared-shell-missing-nav-item"));
  assert.ok(findings.some((f) => f.ruleId === "shared-shell-nav-not-links"));
  assert.ok(findings.some((f) => f.ruleId === "shared-shell-jump-not-explore-button"));
});

test("dashboard route shell contract catches legacy or unshelled owner routes", () => {
  const findings = checkDashboardRouteShellContract({
    files: [
      {
        path: "apps/console/src/app/dashboard/records/page.tsx",
        src: `import { DashboardShell } from "./components/shell"; export default function Page(){ return <DashboardShell/>; }`,
      },
      {
        path: "apps/console/src/app/dashboard/grants/page.tsx",
        src: `export default function Page(){ return <main>raw page</main>; }`,
      },
      {
        path: "apps/console/src/app/dashboard/records/deployment/page.tsx",
        src: `import { redirect } from "next/navigation"; export default function Page(){ redirect("/dashboard/deployment"); }`,
      },
    ],
    fullScreenExceptions: [],
  });
  assert.ok(findings.some((f) => f.ruleId === "legacy-dashboard-shell-route"));
  assert.ok(findings.some((f) => f.ruleId === "dashboard-route-missing-recordroom-shell"));
  assert.equal(
    findings.some((f) => f.path.endsWith("/records/deployment/page.tsx")),
    false,
    "redirect-only aliases do not need the shell"
  );
});

// ── 4. stripComments correctness ─────────────────────────────────────────────

test("stripComments removes comments but preserves string/template content", () => {
  const src = `const a = "keep //this"; // drop this\n/* drop */ const b = \`keep \${x}\`;`;
  const out = stripComments(src);
  assert.ok(out.includes('"keep //this"'));
  assert.ok(out.includes("keep ${x}"));
  assert.ok(!out.includes("drop this"));
  assert.ok(!out.includes("/* drop */"));
});

// ── 5. Current-pages-pass: real source must be clean ─────────────────────────

test("current owner UI source passes the full acceptance scan", async () => {
  const result = await runLocalAcceptance();
  assert.equal(
    result.findings.length,
    0,
    `expected clean owner UI, got findings:\n${result.findings.map((f) => `  [${f.class}] ${f.ruleId} ${f.path}:${f.line}`).join("\n")}`
  );
  assert.equal(result.ok, true);
});

test("owner route discovery scans browser-session, upload, and full nav owner surfaces", async () => {
  const result = await runLocalAcceptance();
  const scanned = new Set(result.scannedFiles.normal);
  assert.ok(
    scanned.has("apps/console/src/app/dashboard/connect/browser-session/[connectorId]/page.tsx"),
    "browser-session setup page must be scanned"
  );
  assert.ok(
    scanned.has("apps/console/src/app/dashboard/connect/browser-session/[connectorId]/launch/page.tsx"),
    "browser-session launch page must be scanned"
  );
  assert.ok(
    scanned.has("apps/console/src/app/dashboard/connect/manual-upload/[connectorId]/page.tsx"),
    "manual upload setup page must be scanned"
  );
  assert.ok(
    scanned.has("apps/console/src/app/dashboard/connect/manual-upload/[connectorId]/manual-upload-form.tsx"),
    "manual upload client form must be scanned"
  );
  assert.ok(
    scanned.has("apps/console/src/app/dashboard/connect/browser-session/[connectorId]/launch/launch-panel.tsx"),
    "browser-session launch client panel must be scanned"
  );
  assert.ok(
    scanned.has("apps/console/src/app/dashboard/records/[connector]/page.tsx"),
    "source detail pages must be scanned"
  );
  for (const file of [
    "apps/console/src/app/dashboard/deployment/page.tsx",
    "apps/console/src/app/dashboard/event-subscriptions/page.tsx",
    "apps/console/src/app/dashboard/explore/page.tsx",
    "apps/console/src/app/dashboard/grants/page.tsx",
    "apps/console/src/app/dashboard/runs/page.tsx",
    "apps/console/src/app/dashboard/schedules/page.tsx",
    "apps/console/src/app/dashboard/search/page.tsx",
    "apps/console/src/app/dashboard/traces/page.tsx",
  ]) {
    assert.ok(scanned.has(file), `${file} must be scanned as a normal owner nav surface`);
  }
});

test("real published surface contains the subcommands rendered in owner UI", async () => {
  const surface = await derivePublishedCommandSurface();
  // The owner UI renders these today; they must exist in the published packages.
  assert.ok(surface["@pdpp/cli"].has("connect"), "@pdpp/cli must publish `connect`");
  for (const sub of ["enroll", "run", "status", "doctor", "retry-dead-letters"]) {
    assert.ok(surface["@pdpp/local-collector"].has(sub), `@pdpp/local-collector must publish \`${sub}\``);
  }
});

test("every rendered PDPP-package command resolves to a published subcommand", async () => {
  const { renderedCommands } = await runLocalAcceptance();
  const pdppCmds = renderedCommands.filter((c) => c.packageName && PUBLISHED_PACKAGES[c.packageName] && c.subcommand);
  assert.ok(pdppCmds.length >= 4, "expected several PDPP package commands rendered");
  for (const c of pdppCmds) {
    assert.equal(c.verified, "published-subcommand", `${c.packageName} ${c.subcommand} should be published`);
  }
});

// ── 6. Report + live-auth redaction ──────────────────────────────────────────

test("report renders findings and never includes auth values", () => {
  const local = {
    ok: false,
    findings: [{ class: "developer-only-path", ruleId: "monorepo-package-path", path: "x.tsx", line: 3, rationale: "no monorepo" }],
    renderedCommands: [],
    publishedSurface: { "@pdpp/cli": ["connect"] },
    scannedFiles: { normal: ["a"], advanced: [], commandSource: [] },
  };
  const live = { ok: true, origin: "https://example.com", authMode: "cookie", surfaces: [], findings: [] };
  const md = renderReport({ local, live, timestamp: "2026-06-10T00:00:00.000Z" });
  assert.ok(md.includes("Result: FAIL"));
  assert.ok(md.includes("monorepo-package-path"));
  assert.ok(md.includes("Owner auth mode: cookie"));
  assert.ok(!md.toLowerCase().includes("bearer "), "report must not echo a bearer value");
});

test("owner auth resolves from env by mode without exposing the value", () => {
  assert.equal(resolveOwnerAuthFromEnv({}).mode, "none");
  const cookie = resolveOwnerAuthFromEnv({ PDPP_OWNER_SESSION_COOKIE: "sid=secret" });
  assert.equal(cookie.mode, "cookie");
  assert.equal(cookie.header.cookie, "sid=secret"); // passed through to fetch, never printed
  const bearer = resolveOwnerAuthFromEnv({ PDPP_OWNER_TOKEN: "tok" });
  assert.equal(bearer.mode, "bearer");
  assert.equal(bearer.header.authorization, "Bearer tok");
});

test("live probe scans served HTML and fails closed on login redirects", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/dashboard/connect")) {
      return { status: 200, text: async () => `<pre>packages/polyfill-connectors/x</pre>` };
    }
    // simulate a login redirect for the others
    return { status: 302, text: async () => "" };
  };
  const result = await runLiveAcceptance({ origin: "https://example.com/", env: {}, fetchImpl });
  assert.equal(result.authMode, "none");
  assert.equal(result.ok, false, "redirected live surfaces are not a passing live gate");
  // The 200 surface with a monorepo path is a finding; the 302s are failed inconclusive probes.
  assert.ok(result.findings.some((f) => f.class === "developer-only-path"));
  assert.ok(result.findings.some((f) => f.ruleId === "live-owner-surface-not-reached"));
  const connect = result.surfaces.find((s) => s.path === "/dashboard/connect");
  assert.equal(connect.reachedOwnerSurface, true);
  const records = result.surfaces.find((s) => s.path === "/dashboard/records");
  assert.equal(records.reachedOwnerSurface, false);
});

test("live probe can create an owner session from PDPP_OWNER_PASSWORD and scan authenticated renders", async () => {
  const calls = [];
  const cookieHeaders = [];
  const response = (status, body, setCookie = null) => ({
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === "set-cookie") {
          return setCookie;
        }
        return null;
      },
    },
    text: async () => body,
  });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).includes("/owner/login") && init.method !== "POST") {
      return response(
        200,
        '<input type="hidden" name="_csrf" value="csrf-1" />',
        "pdpp_owner_csrf=csrf-cookie; Path=/"
      );
    }
    if (String(url).endsWith("/owner/login") && init.method === "POST") {
      assert.ok(String(init.body).includes("password=secret"), "login body carries the password only to fetch");
      assert.equal(init.headers.cookie, "pdpp_owner_csrf=csrf-cookie");
      return response(302, "", "pdpp_owner_session=session-cookie; Path=/; HttpOnly");
    }
    if (String(url).includes("/_ref/connectors")) {
      cookieHeaders.push(init.headers?.cookie ?? "");
      return response(200, JSON.stringify({ object: "list", data: [] }));
    }
    cookieHeaders.push(init.headers?.cookie ?? "");
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com/",
    env: { PDPP_OWNER_PASSWORD: "secret" },
    fetchImpl,
  });

  assert.equal(result.authMode, "password-session");
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
  assert.equal(result.surfaces.every((surface) => surface.reachedOwnerSurface), true);
  assert.ok(cookieHeaders.length >= 4);
  assert.ok(cookieHeaders.every((value) => value === "pdpp_owner_session=session-cookie"));
  assert.ok(!JSON.stringify(result).includes("secret"), "result must not expose the owner password");
  assert.ok(!JSON.stringify(result).includes("session-cookie"), "result must not expose the owner session cookie");
  assert.equal(calls.some((call) => String(call.url).endsWith("/owner/login") && call.init.method === "POST"), true);
});

test("live semantic probe rejects dashboard all-clear when connector summaries contain source issues", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_id: "cin_chase",
              connector_id: "chase",
              display_name: "Chase - Personal",
              rendered_verdict: {
                channel: "advisory",
                pill: { tone: "red", label: "Can't collect" },
                forward_statement: "This connector needs a code fix before it can collect again.",
                required_actions: [
                  { audience: "maintainer", cta: "Code fix needed", satisfied_when: { kind: "none" } },
                ],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard")) {
      return response(
        200,
        "<main><h2>Anything wrong</h2><div>Nothing needs you. Grants are within their limits, backups are on, and sources are syncing.</div></main>"
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "dashboard-source-issue-all-clear"));
  assert.equal(result.semanticChecks?.[0]?.status, "fail");
});

test("live semantic probe passes when material source issues are represented on the dashboard", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_id: "cin_chase",
              connector_id: "chase",
              display_name: "Chase - Personal",
              rendered_verdict: {
                channel: "advisory",
                pill: { tone: "red", label: "Can't collect" },
                forward_statement: "This connector needs a code fix before it can collect again.",
                required_actions: [
                  { audience: "maintainer", cta: "Code fix needed", satisfied_when: { kind: "none" } },
                ],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard")) {
      return response(
        200,
        "<main><h2>Anything wrong</h2><a>Chase - Personal can't collect This connector needs a code fix before it can collect again.</a></main>"
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.semanticChecks?.[0]?.status, "pass");
});

test("live semantic probe does not treat healthy refresh advisories as source issues", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_health: {
                axes: { coverage: "complete", freshness: "stale", outbox: "unknown" },
                reason_code: "stale_manual_refresh",
                state: "healthy",
              },
              connection_id: "cin_reddit",
              connector_id: "reddit",
              display_name: "Reddit - dondochaka",
              rendered_verdict: {
                channel: "advisory",
                forward_statement: "Run a refresh to bring this up to date.",
                pill: { label: "Healthy", tone: "green" },
                required_actions: [
                  {
                    audience: "owner",
                    cta: "Refresh now",
                    satisfied_when: { kind: "confirming_run_succeeded" },
                  },
                ],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard/records/cin_reddit")) {
      return response(200, "<main><section>Run a refresh to bring this up to date.</section><button>Refresh now</button></main>");
    }
    if (href.endsWith("/dashboard")) {
      return response(
        200,
        "<main><h2>Anything wrong</h2><div>Nothing needs you. Grants are within their limits, backups are on, and sources are syncing.</div></main>"
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.semanticChecks?.[0]?.status, "pass");
});

test("live semantic probe rejects healthy refresh advisories rendered as degraded issues", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_health: {
                axes: { coverage: "complete", freshness: "stale", outbox: "unknown" },
                reason_code: "stale_manual_refresh",
                state: "healthy",
              },
              connection_id: "cin_reddit",
              connector_id: "reddit",
              display_name: "Reddit - dondochaka",
              rendered_verdict: {
                channel: "advisory",
                forward_statement: "Run a refresh to bring this up to date.",
                pill: { label: "Healthy", tone: "green" },
                required_actions: [
                  {
                    audience: "owner",
                    cta: "Refresh now",
                    satisfied_when: { kind: "confirming_run_succeeded" },
                  },
                ],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard/records/cin_reddit")) {
      return response(200, "<main><section>Run a refresh to bring this up to date.</section><button>Refresh now</button></main>");
    }
    if (href.endsWith("/dashboard")) {
      return response(
        200,
        "<main><h2>Anything wrong</h2><a>Reddit - dondochaka is degraded Run a refresh to bring this up to date.</a></main>"
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "dashboard-healthy-advisory-overstated"));
  assert.equal(result.semanticChecks?.[0]?.status, "fail");
});

test("live semantic probe rejects raw broken source facts hidden by a calm verdict", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_health: {
                axes: { coverage: "terminal_gap", freshness: "fresh", outbox: "unknown" },
                reason_code: "qfx_download_failed",
                state: "degraded",
              },
              connection_id: "cin_chase",
              connector_id: "chase",
              display_name: "Chase - Personal",
              rendered_verdict: {
                channel: "calm",
                forward_statement: "Current and collecting normally.",
                pill: { label: "Healthy", tone: "green" },
                required_actions: [],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard")) {
      return response(
        200,
        "<main><h2>Anything wrong</h2><div>Nothing needs you. Grants are within their limits, backups are on, and sources are syncing.</div></main>"
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "dashboard-raw-source-issue-missing"));
  assert.equal(result.semanticChecks?.[0]?.status, "fail");
});

test("live semantic probe accepts raw broken source facts represented on the dashboard", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_health: {
                axes: { coverage: "terminal_gap", freshness: "fresh", outbox: "unknown" },
                reason_code: "qfx_download_failed",
                state: "degraded",
              },
              connection_id: "cin_chase",
              connector_id: "chase",
              display_name: "Chase - Personal",
              rendered_verdict: {
                channel: "calm",
                forward_statement: "Current and collecting normally.",
                pill: { label: "Healthy", tone: "green" },
                required_actions: [],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard")) {
      return response(200, "<main><h2>Anything wrong</h2><a>Chase - Personal needs a connector fix.</a></main>");
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.semanticChecks?.[0]?.status, "pass");
});

test("live semantic probe rejects dashboard monograms that pollute client labels", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(200, JSON.stringify({ object: "list", data: [] }));
    }
    if (href.endsWith("/dashboard")) {
      return response(
        200,
        '<main><span class="pdpp-monogram">CL</span><span>Claude</span> reads only your data</main>'
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "dashboard-monogram-not-decorative"));
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "dashboard-decorative-monograms")?.status,
    "fail"
  );
});

test("live semantic probe accepts decorative dashboard monograms", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(200, JSON.stringify({ object: "list", data: [] }));
    }
    if (href.endsWith("/dashboard")) {
      return response(
        200,
        '<main><span aria-hidden="true" class="pdpp-monogram">CL</span><span>Claude</span> reads only your data</main>'
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "dashboard-decorative-monograms")?.status,
    "pass"
  );
});

test("live semantic probe rejects visible source count claims that diverge from connector summaries", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_id: "cin_amazon",
              connector_id: "amazon",
              display_name: "Amazon - Personal",
              stream_count: 2,
              streams: ["orders", "order_items"],
              total_records: 2868,
              rendered_verdict: {
                channel: "calm",
                pill: { tone: "green", label: "Healthy" },
                required_actions: [],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard/records")) {
      return response(200, "<main><h1>Sources</h1><a>Amazon - Personal 2,800 records · 2 streams</a></main>");
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "records-source-count-mismatch"));
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "records-counts-match-reality")?.status,
    "fail"
  );
});

test("live semantic probe accepts visible source count claims that match connector summaries", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_id: "cin_amazon",
              connector_id: "amazon",
              display_name: "Amazon - Personal",
              stream_count: 2,
              streams: ["orders", "order_items"],
              total_records: 2868,
              rendered_verdict: {
                channel: "calm",
                pill: { tone: "green", label: "Healthy" },
                required_actions: [],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard/records")) {
      return response(200, "<main><h1>Sources</h1><a>Amazon - Personal 2,868 records · 2 streams</a></main>");
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "records-counts-match-reality")?.status,
    "pass"
  );
});

test("live semantic probe rejects direct browser-session new-source controls", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [],
        })
      );
    }
    if (href.endsWith("/dashboard/connect/browser-session/amazon")) {
      return response(
        200,
        '<main><h1>Connect Amazon</h1><form action="/dashboard/connect/browser-session/amazon/start" method="post"><button>Start session</button></form></main>'
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "browser-session-direct-new-source"));
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "browser-session-direct-new-source")?.status,
    "fail"
  );
});

test("live semantic probe accepts repair-only browser-session guidance", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [],
        })
      );
    }
    if (href.endsWith("/dashboard/connect/browser-session/amazon")) {
      return response(
        200,
        "<main><h1>Connect Amazon</h1><p>Adding a new Amazon source is not packaged here yet.</p><a>Open sources</a></main>"
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "browser-session-direct-new-source")?.status,
    "pass"
  );
});

test("live semantic probe rejects shell-only Schedules and Explore pages", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(200, JSON.stringify({ object: "list", data: [] }));
    }
    if (href.endsWith("/dashboard/schedules") || href.endsWith("/dashboard/explore")) {
      return response(200, "<main>clean owner shell only</main>");
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "schedules-content-rendered"));
  assert.ok(result.findings.some((f) => f.ruleId === "explore-content-rendered"));
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "schedules-content-rendered")?.status,
    "fail"
  );
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "explore-content-rendered")?.status,
    "fail"
  );
});

test("live semantic probe rejects owner actions that are absent from the exact source route", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_id: "cin_local",
              connector_id: "claude-code",
              display_name: "peregrine Claude Code",
              rendered_verdict: {
                channel: "attention",
                forward_statement: "The local collector has failed uploads.",
                pill: { label: "Can't collect", tone: "red" },
                required_actions: [
                  {
                    audience: "owner",
                    cta: "Recover local collector uploads",
                    remediation: {
                      label: "Recover local collector uploads",
                      summary: "The local collector has failed uploads.",
                      target: { kind: "local_device" },
                    },
                    satisfied_when: { kind: "attention_resolved" },
                  },
                ],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard")) {
      return response(
        200,
        "<main><section>peregrine Claude Code needs you. See what to do.</section></main>"
      );
    }
    if (href.endsWith("/dashboard/records/cin_local")) {
      return response(200, "<main><section>Diagnostics are loading.</section></main>");
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "source-next-action-copy-missing"));
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "whats-next-actionable")?.status,
    "fail"
  );
});

test("live semantic probe accepts owner actions visible on dashboard and exact source route", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_id: "cin_local",
              connector_id: "claude-code",
              display_name: "peregrine Claude Code",
              rendered_verdict: {
                channel: "attention",
                forward_statement: "The local collector has failed uploads.",
                pill: { label: "Can't collect", tone: "red" },
                required_actions: [
                  {
                    audience: "owner",
                    cta: "Recover local collector uploads",
                    remediation: {
                      commands: [
                        {
                          kind: "local_collector_recover_preview",
                          label: "Preview recovery",
                        },
                      ],
                      label: "Recover local collector uploads",
                      summary: "The local collector has failed uploads.",
                      target: { kind: "local_device" },
                    },
                    satisfied_when: { kind: "attention_resolved" },
                  },
                ],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard")) {
      return response(
        200,
        "<main><section>peregrine Claude Code needs you. See what to do.</section></main>"
      );
    }
    if (href.endsWith("/dashboard/records/cin_local")) {
      return response(
        200,
        "<main><h1>peregrine Claude Code</h1><section>Recover local collector uploads</section><section>Preview recovery</section></main>"
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "whats-next-actionable")?.status,
    "pass"
  );
});

test("live semantic probe rejects raw stale manual sources without a visible next action", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_health: {
                axes: { freshness: "stale", coverage: "complete", outbox: "unknown" },
                reason_code: "stale_manual_refresh",
              },
              connection_id: "cin_reddit",
              connector_id: "reddit",
              display_name: "Reddit - dondochaka",
              rendered_verdict: {
                channel: "calm",
                forward_statement: "Current and collecting normally.",
                pill: { label: "Healthy", tone: "green" },
                required_actions: [],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard/records/cin_reddit")) {
      return response(200, "<main><section>Current and collecting normally.</section></main>");
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "raw-next-action-affordance-missing"));
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "whats-next-actionable")?.status,
    "fail"
  );
});

test("live semantic probe accepts raw stale manual sources with a visible refresh action", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_health: {
                axes: { freshness: "stale", coverage: "complete", outbox: "unknown" },
                reason_code: "stale_manual_refresh",
              },
              connection_id: "cin_usaa",
              connector_id: "usaa",
              display_name: "USAA - Personal",
              rendered_verdict: {
                channel: "advisory",
                forward_statement: "Run a refresh to bring this up to date.",
                pill: { label: "Healthy", tone: "green" },
                required_actions: [
                  {
                    audience: "owner",
                    cta: "Refresh now",
                    satisfied_when: { kind: "confirming_run_succeeded" },
                  },
                ],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard/records/cin_usaa")) {
      return response(200, "<main><section>Run a refresh to bring this up to date.</section><button>Refresh now</button></main>");
    }
    if (href.endsWith("/dashboard")) {
      return response(200, "<main><section>USAA - Personal refresh available.</section></main>");
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "whats-next-actionable")?.status,
    "pass"
  );
});

test("live semantic probe rejects raw denial reason codes on dashboard", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(200, JSON.stringify({ object: "list", data: [] }));
    }
    if (href.endsWith("/dashboard")) {
      return response(200, "<main><section>slack tried to read — turned away, orphaned_started_run.</section></main>");
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "dashboard-raw-denial-reason"));
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "dashboard-denial-reasons-humanized")?.status,
    "fail"
  );
});

test("live semantic probe rejects single-token raw denial codes on dashboard", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(200, JSON.stringify({ object: "list", data: [] }));
    }
    if (href.endsWith("/dashboard")) {
      return response(200, "<main><section>slack tried to read — turned away, forbidden.</section></main>");
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "dashboard-raw-denial-reason"));
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "dashboard-denial-reasons-humanized")?.status,
    "fail"
  );
});

test("live semantic probe accepts humanized dashboard denial reasons", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(200, JSON.stringify({ object: "list", data: [] }));
    }
    if (href.endsWith("/dashboard")) {
      return response(
        200,
        "<main><section>slack tried to read — turned away, it was not tied to an active run.</section></main>"
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "dashboard-denial-reasons-humanized")?.status,
    "pass"
  );
});

test("live semantic probe rejects dead-letter jargon on source recovery detail pages", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_id: "cin_local",
              display_name: "Claude Code",
              rendered_verdict: {
                channel: "attention",
                forward_statement: "The local collector has failed uploads.",
                pill: { label: "Can't collect", tone: "red" },
                required_actions: [{ audience: "owner", satisfied_when: { kind: "manual" } }],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard")) {
      return response(200, "<main><section>Claude Code can't collect</section></main>");
    }
    if (href.endsWith("/dashboard/records/cin_local")) {
      return response(200, "<main><section>Stuck on the device: 3 dead-letter.</section></main>");
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "source-detail-raw-recovery-jargon"));
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "source-detail-recovery-copy-humanized")?.status,
    "fail"
  );
});

test("live semantic probe accepts failed-upload owner copy on source recovery detail pages", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_id: "cin_local",
              display_name: "Claude Code",
              rendered_verdict: {
                channel: "attention",
                forward_statement: "The local collector has failed uploads.",
                pill: { label: "Can't collect", tone: "red" },
                required_actions: [{ audience: "owner", satisfied_when: { kind: "manual" } }],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard")) {
      return response(200, "<main><section>Claude Code can't collect</section></main>");
    }
    if (href.endsWith("/dashboard/records/cin_local")) {
      return response(
        200,
        "<main><section>Stuck on the device: 3 failed uploads.</section><code>pdpp local-collector retry-dead-letters --connection-id cin_local</code></main>"
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "source-detail-recovery-copy-humanized")?.status,
    "pass"
  );
});

test("live semantic probe rejects clean-success source detail copy when collection gaps remain", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_id: "cin_chase",
              display_name: "Chase - Personal",
              last_run: { run_id: "run_1", status: "succeeded" },
              collection_report: [
                {
                  stream: "transactions",
                  coverage_condition: "terminal_gap",
                  pending_detail_gaps: 1,
                  skipped: { reason: "qfx_download_failed" },
                },
              ],
              rendered_verdict: {
                channel: "advisory",
                forward_statement: "This connector needs a code fix before it can collect again.",
                pill: { label: "Can't collect", tone: "red" },
                required_actions: [{ audience: "maintainer", satisfied_when: { kind: "none" } }],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard")) {
      return response(200, "<main><section>Chase - Personal can't collect</section></main>");
    }
    if (href.endsWith("/dashboard/records/cin_chase")) {
      return response(
        200,
        "<main><section>Last 1 runs ✓ 0 failures · Open runs →</section><section>Known source runs succeeded run_1</section></main>"
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "source-detail-clean-success-with-open-gaps"));
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "source-detail-run-gap-honesty")?.status,
    "fail"
  );
});

test("live semantic probe accepts partial source detail copy when collection gaps remain", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(
        200,
        JSON.stringify({
          object: "list",
          data: [
            {
              connection_id: "cin_chase",
              display_name: "Chase - Personal",
              last_run: { run_id: "run_1", status: "succeeded" },
              collection_report: [
                {
                  stream: "transactions",
                  coverage_condition: "retryable_gap",
                  pending_detail_gaps: 1,
                  skipped: null,
                },
              ],
              rendered_verdict: {
                channel: "advisory",
                forward_statement: "The next run is expected to fill the remaining data.",
                pill: { label: "Degraded", tone: "amber" },
                required_actions: [{ audience: "owner", satisfied_when: { kind: "manual" } }],
              },
            },
          ],
        })
      );
    }
    if (href.endsWith("/dashboard")) {
      return response(200, "<main><section>Chase - Personal degraded</section></main>");
    }
    if (href.endsWith("/dashboard/records/cin_chase")) {
      return response(
        200,
        "<main><section>Last 1 runs ⚠ 1 with gaps · Open runs →</section><section>Known source runs partial run_1</section></main>"
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(
    result.semanticChecks?.find((check) => check.id === "source-detail-run-gap-honesty")?.status,
    "pass"
  );
});

test("live semantic probe rejects raw technical client ids as visible grant captions", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(200, JSON.stringify({ object: "list", data: [] }));
    }
    if (href.endsWith("/dashboard/grants")) {
      return response(200, "<main><article>slack active client cli_348b7036fe7172ba 7 hours ago</article></main>");
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "grants-raw-client-caption"));
  assert.equal(result.semanticChecks?.find((check) => check.id === "grants-client-caption-humanized")?.status, "fail");
});

test("live semantic probe rejects raw URL client ids as visible grant captions", async () => {
  const response = (status, body) => ({
    status,
    headers: { get: () => null },
    text: async () => body,
  });
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/_ref/connectors")) {
      return response(200, JSON.stringify({ object: "list", data: [] }));
    }
    if (href.endsWith("/dashboard/grants")) {
      return response(
        200,
        '<main><article>github active client https://chatgpt.com/oauth/client.json?token_endpoint_auth_method=none</article></main>'
      );
    }
    return response(200, defaultLiveOwnerPageHtml(url));
  };

  const result = await runLiveAcceptance({
    origin: "https://example.com",
    env: { PDPP_OWNER_SESSION_COOKIE: "sid=secret" },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.ruleId === "grants-raw-client-caption"));
  assert.equal(result.semanticChecks?.find((check) => check.id === "grants-client-caption-humanized")?.status, "fail");
});

// ── 7. Clean-shell freshness (opt-in, injected probe — no real network) ──────

test("clean-shell probe flags a rendered subcommand missing from published --help", async () => {
  const renderedCommands = [
    { packageName: "@pdpp/cli", subcommand: "connect", path: "p", line: 1 },
    { packageName: "@pdpp/cli", subcommand: "owner-agent-explain", path: "p", line: 2 },
  ];
  // Injected probe: published help mentions `connect` but not `owner-agent-explain`.
  const probe = async () => ({ ok: true, help: "Usage: pdpp <connect|token|read>", error: null });
  const { findings } = await checkCleanShellFreshness({
    renderedCommands,
    publishedPackages: PUBLISHED_PACKAGES,
    probe,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, "clean-shell-missing-subcommand");
  assert.ok(findings[0].excerpt.includes("owner-agent-explain"));
});

test("clean-shell probe passes when every rendered subcommand is in --help", async () => {
  const renderedCommands = [{ packageName: "@pdpp/cli", subcommand: "connect", path: "p", line: 1 }];
  const probe = async () => ({ ok: true, help: "Usage: pdpp <connect|token>", error: null });
  const { findings } = await checkCleanShellFreshness({
    renderedCommands,
    publishedPackages: PUBLISHED_PACKAGES,
    probe,
  });
  assert.deepEqual(findings, []);
});

test("clean-shell probe records a resolution failure as a finding", async () => {
  const renderedCommands = [{ packageName: "@pdpp/cli", subcommand: "connect", path: "p", line: 1 }];
  const probe = async () => ({ ok: false, help: "", error: "ENOTFOUND registry" });
  const { findings, probes } = await checkCleanShellFreshness({
    renderedCommands,
    publishedPackages: PUBLISHED_PACKAGES,
    probe,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, "clean-shell-probe-failed");
  assert.equal(probes[0].ok, false);
});

test("does not treat the shared pdpp build label as a CLI command", () => {
  assert.equal(parseCommand("pdpp 0.1.0"), null);
});

// Helper used by several forbidden-string tests above.
function found(src, ruleId) {
  return scanNormal(src).some((f) => f.ruleId === ruleId);
}
