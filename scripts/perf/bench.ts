#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Repeatable performance benchmark for the PDPP product surface.
 *
 * Measures, against a running stack, with multiple samples per target and
 * percentile stats (p50/p95/p99/min/max/mean):
 *   - RS read-surface API endpoints (schema, search lexical/semantic/hybrid,
 *     records query, aggregate) — the perf-critical agent-facing surface.
 *   - Console owner page loads (TTFB + full HTML transfer) for the key routes.
 *
 * Dependency-light: Node's built-in fetch + performance.now(). No autocannon/k6.
 * Results are written to a timestamped JSON under perf-results/ (gitignored) so
 * runs are comparable over time (regression detection), plus a readable table to
 * stdout.
 *
 * Usage:
 *   node --import tsx scripts/perf/bench.ts                          # live, default samples
 *   PDPP_BASE=https://pdpp.example.com node --import tsx scripts/perf/bench.ts
 *   PDPP_OWNER_TOKEN=... node --import tsx scripts/perf/bench.ts      # auth RS targets
 *   PDPP_BENCH_SAMPLES=30 node --import tsx scripts/perf/bench.ts
 *   node --import tsx scripts/perf/bench.ts --api-only | --pages-only
 *   node --import tsx scripts/perf/bench.ts --pages-only --login            # authed page timings (real owner experience)
 *   node --import tsx scripts/perf/bench.ts --compare <prior-result.json>   # regression diff
 *
 * Env:
 *   PDPP_BASE              base URL (default https://pdpp.example.com)
 *   PDPP_OWNER_TOKEN       bearer for RS /v1 targets (skips them if unset)
 *   PDPP_OWNER_PASSWORD    owner password for console page cookie auth (optional)
 *   PDPP_BENCH_SAMPLES     samples per target (default 12)
 *   PDPP_BENCH_WARMUP      warmup requests per target, not counted (default 2)
 *   PDPP_BENCH_TIMEOUT_MS  per-request timeout (default 30000)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const RESULTS_DIR = join(REPO_ROOT, "perf-results");

const TRAILING_SLASH_PATTERN = /\/$/;
const BASE = (process.env.PDPP_BASE || "https://pdpp.example.com").replace(TRAILING_SLASH_PATTERN, "");
const OWNER_TOKEN = process.env.PDPP_OWNER_TOKEN || "";
const SAMPLES = Number(process.env.PDPP_BENCH_SAMPLES || 12);
const WARMUP = Number(process.env.PDPP_BENCH_WARMUP || 2);
const TIMEOUT_MS = Number(process.env.PDPP_BENCH_TIMEOUT_MS || 30_000);
// A real connection to disambiguate the shared `messages` stream for records targets.
const CONNECTION_ID = process.env.PDPP_BENCH_CONNECTION_ID || "cin_f565a96cb0a114b0a27e9606";

const args = new Set(process.argv.slice(2));
const API_ONLY = args.has("--api-only");
const PAGES_ONLY = args.has("--pages-only");
const compareIdx = process.argv.indexOf("--compare");
const COMPARE_PATH = compareIdx >= 0 ? process.argv[compareIdx + 1] : null;

// ── targets ────────────────────────────────────────────────────────────────

interface Target {
  group: "api" | "page";
  headers: Record<string, string>;
  marker?: string;
  name: string;
  url: string;
}

/** RS read-surface API targets. Skipped entirely when no owner token. */
function apiTargets(): Target[] {
  if (!OWNER_TOKEN) {
    return [];
  }
  const h = { Authorization: `Bearer ${OWNER_TOKEN}` };
  const q = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;
  return [
    { group: "api", name: "schema", url: `${BASE}/v1/schema`, headers: h },
    { group: "api", name: "search.lexical", url: `${BASE}/v1/search${q({ q: "error", limit: "25" })}`, headers: h },
    {
      group: "api",
      name: "search.semantic",
      url: `${BASE}/v1/search/semantic${q({ q: "deployment failure", limit: "25" })}`,
      headers: h,
    },
    {
      group: "api",
      name: "search.hybrid",
      url: `${BASE}/v1/search/hybrid${q({ q: "deployment failure", limit: "25" })}`,
      headers: h,
    },
    // messages is shared across connectors → must disambiguate with connection_id.
    // PDPP_BENCH_CONNECTION_ID lets a run pin a real connection; default below is a
    // live Slack connection (override per-instance). A 400 here in results means the
    // pinned connection_id was wrong, not a perf signal.
    {
      group: "api",
      name: "records.page",
      url: `${BASE}/v1/streams/messages/records${q({ limit: "25", connection_id: CONNECTION_ID })}`,
      headers: h,
    },
    {
      group: "api",
      name: "records.count",
      url: `${BASE}/v1/streams/messages/records${q({ limit: "1", count: "exact", connection_id: CONNECTION_ID })}`,
      headers: h,
    },
  ];
}

/** Fetch an owner-session cookie via PDPP_OWNER_PASSWORD so authed page profiling
 *  is a one-liner (`--login`). Returns "" if unavailable; page validation then
 *  fails instead of recording an unauthenticated redirect as a page result. */
async function fetchOwnerCookie(): Promise<string> {
  const password = process.env.PDPP_OWNER_PASSWORD;
  if (!password) {
    return "";
  }
  try {
    const resp = await fetch(`${BASE}/owner/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      redirect: "manual",
    });
    const setCookie = resp.headers.getSetCookie?.() || [];
    const session = setCookie.find((c) => c.startsWith("pdpp_owner_session="));
    return session ? (session.split(";")[0] ?? "") : "";
  } catch {
    return "";
  }
}

/** Current public owner-console routes and their route-specific HTML evidence.
 * A successful HTTP response alone is insufficient: a login redirect, not-found
 * page, or error shell can otherwise produce a deceptively quick page benchmark. */
export const PAGE_TARGETS = [
  { route: "/", marker: 'class="rr-stand"' },
  { route: "/sources", marker: '<h1 class="pdpp-heading text-foreground">Sources</h1>' },
  { route: "/sources/add", marker: '<h1 class="pdpp-heading break-words text-foreground">Add source</h1>' },
  { route: "/explore", marker: 'aria-label="Search or filter"' },
  { route: "/syncs", marker: '<h1 class="rr-sync__title">Syncs</h1>' },
  { route: "/grants", marker: '<h1 class="pdpp-heading break-words text-foreground">Grants</h1>' },
  { route: "/connect", marker: '<h1 class="pdpp-heading break-words text-foreground">Connect AI apps</h1>' },
  { route: "/search", marker: '<h1 class="pdpp-heading break-words text-foreground">Jump to artifact</h1>' },
] as const;

const ERROR_SHELL_PATTERNS = [
  /<h1[^>]*>\s*Something went wrong\s*<\/h1>/i,
  /<p[^>]*>\s*Read error\s*<\/p>/i,
  /<h[12][^>]*>\s*Reference server unreachable\s*<\/h[12]>/i,
  /<h1[^>]*>\s*This page could not be found\s*<\/h1>/i,
  /<p[^>]*>\s*this is a display failure, not a change\s*<\/p>/i,
];

/** Console page targets require an owner session so measurements represent the
 * real owner page rather than a login redirect. */
export function pageTargets(cookieOverride: string): Target[] {
  const cookie = cookieOverride || process.env.PDPP_BENCH_COOKIE || "";
  const headers = cookie ? { Cookie: cookie } : {};
  return PAGE_TARGETS.map(({ route, marker }) => ({
    group: "page" as const,
    headers,
    marker,
    name: route,
    url: `${BASE}${route}`,
  }));
}

// ── measurement ──────────────────────────────────────────────────────────────

interface SampleResult {
  bytes: number;
  failure: string | null;
  status: number;
  totalMs: number;
  ttfbMs: number | null;
}

async function timeOnce(target: Target): Promise<SampleResult> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  let status = 0;
  let bytes = 0;
  let failure: string | null = null;
  let ttfbMs: number | null = null;
  try {
    const resp = await fetch(target.url, {
      headers: target.headers,
      redirect: "manual",
      signal: ctrl.signal,
    });
    ({ status } = resp);
    // TTFB ≈ time to headers; we approximate by marking now (fetch resolves on
    // headers received for the body stream).
    ttfbMs = performance.now() - t0;
    if (target.group === "page") {
      const body = await resp.text();
      bytes = Buffer.byteLength(body);
      failure = validatePageResponse(target, { body, contentType: resp.headers.get("content-type"), status });
    } else {
      const body = await resp.arrayBuffer();
      bytes = body.byteLength;
    }
  } catch {
    status = -1;
    failure = "request failed or timed out";
  } finally {
    clearTimeout(to);
  }
  const totalMs = performance.now() - t0;
  return { totalMs, ttfbMs, status, bytes, failure };
}

/** Returns why a page response is not usable performance evidence, or null. */
export function validatePageResponse(
  target: Pick<Target, "marker">,
  { body, contentType, status }: { readonly body: string; readonly contentType: string | null; readonly status: number }
): string | null {
  if (status !== 200) {
    return `expected HTTP 200, received ${status}`;
  }
  if (!contentType?.includes("text/html")) {
    return `expected HTML, received ${contentType || "no content type"}`;
  }
  if (ERROR_SHELL_PATTERNS.some((pattern) => pattern.test(body))) {
    return "received an error shell";
  }
  if (!(target.marker && body.includes(target.marker))) {
    return `missing page marker ${JSON.stringify(target.marker)}`;
  }
  return null;
}

function pct(sorted: number[], p: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? null;
}

interface Stats {
  bytes: number;
  max: number | null;
  mean: number | null;
  min: number | null;
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  statuses: number[];
}

function stats(samples: SampleResult[]): Stats {
  const totals = samples.map((s) => s.totalMs).sort((a, b) => a - b);
  const sum = totals.reduce((a, b) => a + b, 0);
  return {
    n: totals.length,
    min: round(totals[0] ?? null),
    p50: round(pct(totals, 50)),
    p95: round(pct(totals, 95)),
    p99: round(pct(totals, 99)),
    max: round(totals.at(-1) ?? null),
    mean: round(sum / totals.length),
    statuses: [...new Set(samples.map((s) => s.status))],
    bytes: Math.round(samples.reduce((a, s) => a + s.bytes, 0) / samples.length),
  };
}

const round = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

type BenchResult = { failures: string[]; group: string; name: string; ok: boolean; url: string } & Stats;

async function benchTarget(target: Target): Promise<BenchResult> {
  for (let i = 0; i < WARMUP; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: intentionally sequential — one request at a time to get accurate per-request latency, not throughput; concurrent requests would distort the timing this benchmark measures.
    await timeOnce(target);
  }
  const samples: SampleResult[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: see the warmup loop above — sequential by design.
    samples.push(await timeOnce(target));
  }
  const failures = [
    ...new Set(samples.map((sample) => sample.failure).filter((failure): failure is string => failure !== null)),
  ];
  return {
    group: target.group,
    name: target.name,
    ok: failures.length === 0 && samples.every((sample) => sample.status >= 200 && sample.status < 400),
    url: target.url,
    failures,
    ...stats(samples),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

interface BenchOutput {
  base: string;
  ran_at: string;
  results: BenchResult[];
  samples: number;
  schema: string;
  warmup: number;
}

async function main(): Promise<void> {
  // --login auto-fetches an owner-session cookie so page timings are the real
  // authed experience without manual cookie extraction.
  const cookie = args.has("--login") ? await fetchOwnerCookie() : "";
  if (args.has("--login") && !cookie) {
    console.error("# --login: no cookie (set PDPP_OWNER_PASSWORD) — page validation will fail");
  }
  const targets: Target[] = [...(PAGES_ONLY ? [] : apiTargets()), ...(API_ONLY ? [] : pageTargets(cookie))];
  if (targets.length === 0) {
    console.error("No targets. (RS API targets need PDPP_OWNER_TOKEN; pages need none.)");
    process.exit(2);
  }

  console.error(`# PDPP perf bench — base=${BASE} samples=${SAMPLES} warmup=${WARMUP}`);
  if (!(OWNER_TOKEN || PAGES_ONLY)) {
    console.error("# (no PDPP_OWNER_TOKEN → RS /v1 API targets skipped)");
  }

  const results: BenchResult[] = [];
  for (const t of targets) {
    // biome-ignore lint/performance/noAwaitInLoops: intentionally sequential — one target benchmarked at a time so its own warmup+sample requests aren't contending with another target's for the same server/network capacity.
    const r = await benchTarget(t);
    results.push(r);
    console.error(
      `  ${pad(r.group, 5)} ${pad(r.name, 26)} ${r.ok ? "OK  " : "FAIL"} p50=${pad(r.p50, 7)}ms p95=${pad(r.p95, 7)}ms max=${pad(r.max, 7)}ms  [${r.statuses.join(",")}] ${fmtBytes(r.bytes)}${r.failures.length ? ` — ${r.failures.join("; ")}` : ""}`
    );
  }

  const out: BenchOutput = {
    schema: "pdpp-perf-bench/1",
    base: BASE,
    samples: SAMPLES,
    warmup: WARMUP,
    // No Date.now() in some sandboxes; here we are a normal node script so it's fine.
    ran_at: new Date().toISOString(),
    results,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const TIMESTAMP_SANITIZE_PATTERN = /[:.]/g;
  const stamp = out.ran_at.replace(TIMESTAMP_SANITIZE_PATTERN, "-");
  const outPath = join(RESULTS_DIR, `bench-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  writeFileSync(join(RESULTS_DIR, "bench-latest.json"), JSON.stringify(out, null, 2));
  console.error(`\n# wrote ${outPath}`);

  if (COMPARE_PATH) {
    compare(out, COMPARE_PATH);
  }

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }

  // Machine-readable to stdout for piping.
  console.log(JSON.stringify(out));
}

function compare(current: BenchOutput, priorPath: string): void {
  let prior: BenchOutput;
  try {
    prior = JSON.parse(readFileSync(priorPath, "utf8"));
  } catch (e) {
    console.error(`# --compare: cannot read ${priorPath}: ${(e as Error).message}`);
    return;
  }
  const byName = new Map(prior.results.map((r) => [`${r.group}:${r.name}`, r]));
  console.error(`\n# regression vs ${priorPath} (p50 Δ, >15% slower flagged):`);
  for (const r of current.results) {
    const p = byName.get(`${r.group}:${r.name}`);
    if (!p || p.p50 === null || r.p50 === null) {
      continue;
    }
    const deltaPct = ((r.p50 - p.p50) / p.p50) * 100;
    let flag = "";
    if (deltaPct > 15) {
      flag = " ⚠ SLOWER";
    } else if (deltaPct < -15) {
      flag = " ✓ faster";
    }
    console.error(
      `  ${pad(r.name, 26)} ${pad(p.p50, 7)} → ${pad(r.p50, 7)}ms (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(0)}%)${flag}`
    );
  }
}

function pad(v: unknown, n: number): string {
  return String(v ?? "").padStart(n);
}
function fmtBytes(b: number): string {
  if (b < 1024) {
    return `${b}B`;
  }
  if (b < 1024 * 1024) {
    return `${(b / 1024).toFixed(1)}KB`;
  }
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
