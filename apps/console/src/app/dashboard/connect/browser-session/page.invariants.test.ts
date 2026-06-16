/**
 * Source-regex guard for the owner-facing browser-session setup page.
 *
 * This page is for a normal owner trying to connect a browser-backed source.
 * Operator runbooks, internal browser service names, and repository paths belong
 * in diagnostics/operator surfaces, not in the primary setup journey.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}[connectorId]/page.tsx`;
const START_ROUTE_FILE = `${HERE}[connectorId]/start/route.ts`;

const SECURE_BROWSER_COPY_RE = /secure browser/;
const OPERATOR_ARTIFACT_RE =
  /BROWSER_BOUND_RUNBOOK_PATH|browser-collector runbook|docs\/operator\/browser-collector-proof-runbook\.md|\bneko\b|n\.eko|hosted Chromium/;
const SERVER_ACTION_TRANSPORT_RE = /startBrowserEnrollmentAction|from "\.\/actions\.ts"|<form action=\{[^}]+Action/;
const POST_ROUTE_TRANSPORT_RE =
  /<form action=\{`\/dashboard\/connect\/browser-session\/\$\{encodeURIComponent\(connectorId\)\}\/start`\} method="post">/;
const START_ROUTE_POST_RE = /export async function POST/;
const START_ROUTE_AUTH_RE = /await requireDashboardAccess\(pagePath\(connectorId\)\)/;
const START_ROUTE_SETUP_RE = /createBrowserEnrollmentShell\(connectorId\)/;
const START_ROUTE_REPAIR_RE = /formData\.get\("connection_id"\)/;
const START_ROUTE_RUN_RE = /runConnectionNow\(connectionId\)/;
const START_ROUTE_CLEANUP_RE = /abandonBrowserEnrollmentShell\(shell\.connection_id\)/;
const START_ROUTE_REDIRECT_RE = /NextResponse\.redirect\(new URL\(path, request\.url\), 303\)/;

test("browser-session page does not send owners to operator/browser-service artifacts", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, SECURE_BROWSER_COPY_RE);
  assert.doesNotMatch(src, OPERATOR_ARTIFACT_RE);
});

test("browser-session start uses a normal POST route, not Server Action fetch transport", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const route = await readFile(START_ROUTE_FILE, "utf8");

  assert.doesNotMatch(src, SERVER_ACTION_TRANSPORT_RE);
  assert.match(src, POST_ROUTE_TRANSPORT_RE);
  assert.match(route, START_ROUTE_POST_RE);
});

test("browser-session start route preserves auth, setup, repair, redirect, and cleanup semantics", async () => {
  const route = await readFile(START_ROUTE_FILE, "utf8");

  assert.match(route, START_ROUTE_AUTH_RE);
  assert.match(route, START_ROUTE_SETUP_RE);
  assert.match(route, START_ROUTE_REPAIR_RE);
  assert.match(route, START_ROUTE_RUN_RE);
  assert.match(route, START_ROUTE_CLEANUP_RE);
  assert.match(route, START_ROUTE_REDIRECT_RE);
});
