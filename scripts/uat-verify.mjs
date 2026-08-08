#!/usr/bin/env node
// Mechanical UAT verifier for the PDPP console.
//
// Every check is a deterministic assertion against the RUNNING instance — the
// rendered DOM or the live DB — not against source. Source-level guards already
// live in the test suites; this exists because several fixes passed their tests
// while failing in the deployed app (a sidebar fix applied to a component no
// page renders; a runtime error-extraction fix on a path the connector bypassed).
//
// Usage:
//   node scripts/uat-verify.mjs                      # all checks
//   node scripts/uat-verify.mjs --json               # machine-readable
//   BASE=http://localhost:3012 CONTAINER=pdpp-final-uat node scripts/uat-verify.mjs
//
// Exit 0 = every check passed. Exit 1 = at least one FAIL.
// A check that cannot run (missing fixture data) reports SKIP, never a false PASS.

import { execFileSync } from "node:child_process";

const BASE = process.env.BASE || "http://localhost:3012";
const CONTAINER = process.env.CONTAINER || "pdpp-final-uat";
const JSON_OUT = process.argv.includes("--json");

function sql(query) {
  const script = `
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync('/var/lib/pdpp/pdpp.sqlite',{readOnly:true});
console.log(JSON.stringify(db.prepare(${JSON.stringify(query)}).all()));
`;
  const out = execFileSync("docker", ["exec", CONTAINER, "node", "--input-type=module", "-e", script], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split("\n").pop());
}

function ownerPassword() {
  return execFileSync("docker", ["exec", CONTAINER, "cat", "/var/lib/pdpp/owner-password"], {
    encoding: "utf8",
  }).trim();
}

// ── authenticated fetch ──────────────────────────────────────────────────────
let cookie = "";

async function login() {
  const page = await fetch(`${BASE}/owner/login`, { redirect: "manual" });
  const setCookie = page.headers.getSetCookie?.() ?? [];
  cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const html = await page.text();
  const token = html.match(/name="_csrf" value="([^"]*)"/)?.[1] ?? "";
  const body = new URLSearchParams({ _csrf: token, password: ownerPassword() });
  const res = await fetch(`${BASE}/owner/login`, {
    body,
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    method: "POST",
    redirect: "manual",
  });
  const after = res.headers.getSetCookie?.() ?? [];
  if (after.length > 0) {
    cookie = after.map((c) => c.split(";")[0]).join("; ");
  }
}

async function html(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  if (res.status === 307 || res.status === 302) {
    throw new Error(`not authenticated for ${path} (redirected to ${res.headers.get("location")})`);
  }
  return await res.text();
}

// Rendered text, tags stripped — approximates what an owner actually reads.
function visibleText(markup) {
  return markup
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

// ── checks ───────────────────────────────────────────────────────────────────
const results = [];
const record = (id, status, detail) => results.push({ detail, id, status });

async function checkSourcesList() {
  const markup = await html("/sources");
  const text = visibleText(markup);
  const strayOpen = (markup.match(/rr-s-item-open/g) || []).length;
  record(
    "sources.no-stray-open-column",
    strayOpen === 0 ? "PASS" : "FAIL",
    `rr-s-item-open occurrences: ${strayOpen} (owner: "weird two column Open ... ew")`
  );
  record(
    "sources.no-server-settings-dead-end",
    text.includes("Server settings needed before setup") ? "FAIL" : "PASS",
    'owner: "I never want to see this again"'
  );
}

async function checkSourceDetail() {
  const rows = sql(
    "select connector_id from connector_summary_evidence where status='active' and total_records>0 order by total_records desc limit 1"
  );
  if (rows.length === 0) {
    record("source-detail.order", "SKIP", "no active source with records to render");
    return;
  }
  const text = visibleText(await html(`/sources/${rows[0].connector_id}`));
  const streams = text.indexOf("Streams");
  const diagnostics = text.indexOf("Diagnostics");
  record(
    "source-detail.streams-before-diagnostics",
    streams !== -1 && diagnostics !== -1 && streams < diagnostics ? "PASS" : "FAIL",
    `Streams@${streams} Diagnostics@${diagnostics} (owner: "Diagnostics is ... the first thing you see")`
  );
  for (const [id, needle] of [
    ["source-detail.no-drain-jargon", "detail-gap backlog"],
    ["source-detail.no-attention-layer-jargon", "attention layer"],
    ["source-detail.no-negative-statement", "This is not revoke"],
  ]) {
    record(id, text.includes(needle) ? "FAIL" : "PASS", `renders "${needle}": ${text.includes(needle)}`);
  }
}

async function checkRunDetail() {
  const rows = sql("select run_id, connector_id from run_history order by started_at desc limit 1");
  if (rows.length === 0) {
    record("run-detail.links-to-source", "SKIP", "no runs recorded");
    return;
  }
  const markup = await html(`/syncs/${rows[0].run_id}`);
  const text = visibleText(markup);
  record(
    "run-detail.links-to-source",
    markup.includes('href="/sources/') ? "PASS" : "FAIL",
    'owner: "i cant get to the connection/source from its run"'
  );
  record(
    "run-detail.no-self-contradiction",
    text.includes("No partial source-coverage gaps were reported") ? "FAIL" : "PASS",
    "section must not deny what it just reported"
  );
}

async function checkStorageRendering() {
  // Deliberately NOT asserted against the DB column: `total_retained_bytes` is
  // `NOT NULL DEFAULT 0`, so a literal 0 there is the correct storage
  // placeholder. The defect was on the READ path, which discarded the sibling
  // `retained_bytes_state`. So the only meaningful assertion is what the
  // deployment page RENDERS for a connection whose projection is stale.
  const stale = sql(
    "select connector_id from connector_summary_evidence where status!='revoked' and retained_bytes_state!='current' limit 1"
  );
  if (stale.length === 0) {
    record("storage.stale-size-renders-unknown", "SKIP", "no stale retained-size projection to exercise");
    return;
  }
  const text = visibleText(await html("/deployment"));
  // An em-dash (or explicit "not measured") is the sanctioned unknown state;
  // a literal "0 B" for a stale row is the fabrication.
  const fabricates = /\b0\s*B\b/.test(text);
  record(
    "storage.stale-size-renders-unknown",
    fabricates ? "FAIL" : "PASS",
    fabricates
      ? `deployment page renders a literal "0 B" while ${stale[0].connector_id} is stale`
      : `stale projection (${stale[0].connector_id}) renders as unknown, not 0 B`
  );
}

function checkConnectorHealth() {
  const skipped = sql(
    "select connector_id, error from run_history where status='skipped' and error like '%credential_present_and_unrejected%' and started_at > datetime('now','-1 hour')"
  );
  record(
    "scheduler.no-self-poisoning-skip-loop",
    skipped.length === 0 ? "PASS" : "FAIL",
    skipped.length === 0
      ? "no skip in the last hour carried the contradictory reason"
      : `still looping: ${skipped.map((r) => r.connector_id).join(", ")}`
  );

  const opaque = sql(
    "select connector_id, connector_error_json from run_history where connector_error_json like '%Command failed%' and connector_error_json not like '%server:%' and started_at > datetime('now','-1 hour')"
  );
  record(
    "runtime.imap-errors-carry-detail",
    opaque.length === 0 ? "PASS" : "FAIL",
    opaque.length === 0
      ? "no contentless 'Command failed' in the last hour"
      : `opaque on: ${opaque.map((r) => r.connector_id).join(", ")}`
  );
}

function checkBrowserRuntime() {
  const pid = execFileSync(
    "docker",
    ["exec", CONTAINER, "sh", "-c", "pgrep -f 'reference-implementation/server/index.ts' | head -1"],
    { encoding: "utf8" }
  ).trim();
  if (!pid) {
    record("browser-runtime.server-sees-display", "SKIP", "server process not found");
    return;
  }
  const env = execFileSync(
    "docker",
    ["exec", CONTAINER, "sh", "-c", `tr '\\0' '\\n' < /proc/${pid}/environ | grep -E '^(DISPLAY|PDPP_RUNTIME_BROWSER)='`],
    { encoding: "utf8" }
  );
  const ok = /PDPP_RUNTIME_BROWSER=1/.test(env) && /DISPLAY=:\d+/.test(env);
  record(
    "browser-runtime.server-sees-display",
    ok ? "PASS" : "FAIL",
    ok ? "gate can see the image's own browser" : `env: ${env.replace(/\s+/g, " ")}`
  );

  const chatgptSkips = sql(
    "select count(*) n from run_history where connector_id='chatgpt' and status='skipped' and started_at > datetime('now','-1 hour')"
  );
  record(
    "browser-runtime.chatgpt-not-skipped",
    (chatgptSkips[0]?.n ?? 0) === 0 ? "PASS" : "FAIL",
    `chatgpt skips in the last hour: ${chatgptSkips[0]?.n ?? 0}`
  );
}

// ── main ─────────────────────────────────────────────────────────────────────
try {
  await login();
  await checkSourcesList();
  await checkSourceDetail();
  await checkRunDetail();
  await checkStorageRendering();
  checkConnectorHealth();
  checkBrowserRuntime();
} catch (err) {
  record("harness", "FAIL", err instanceof Error ? err.message : String(err));
}

const failed = results.filter((r) => r.status === "FAIL");
if (JSON_OUT) {
  console.log(JSON.stringify({ failed: failed.length, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.status.padEnd(4)} ${r.id.padEnd(46)} ${r.detail}`);
  }
  console.log(
    `\n${results.filter((r) => r.status === "PASS").length} pass, ${failed.length} fail, ${
      results.filter((r) => r.status === "SKIP").length
    } skip`
  );
}
process.exit(failed.length > 0 ? 1 : 0);
