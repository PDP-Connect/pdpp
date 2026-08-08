#!/usr/bin/env node
// Rendered-DOM SLVP verifier for the PDPP console. Sibling to uat-verify.mjs,
// not a replacement — that one's fetch()+DB checks stay, they're fast and
// still useful. This one exists because they cannot see layout: uat-verify.mjs
// strips tags to extract text, so a positioning bug where two elements render
// correctly-ordered but visually on top of each other is invisible to it by
// construction. A 2026-08-08 red-team pass found six real live-instance
// defects; five were invisible to uat-verify.mjs for exactly this reason (see
// docs/inbox/redteam-slvp-findings.md, "Gaps in scripts/uat-verify.mjs").
//
// This drives a REAL BROWSER (patchright/Chromium) and measures the rendered
// DOM: getBoundingClientRect() for overlap and touch targets,
// document.documentElement.scrollWidth for overflow, actual visible text
// nodes for jargon, focus/aria state for accessibility. It needs a browser
// binary, so unlike uat-verify.mjs it is NOT a hermetic unit test — it is
// opt-in / nightly, run by hand or in a scheduled job against a live
// instance, never in a fast CI unit-test pass.
//
// Usage:
//   node scripts/slvp-verify.mjs                 # report-only, always exit 0
//   node scripts/slvp-verify.mjs --strict         # exit 1 on any FAIL
//   node scripts/slvp-verify.mjs --json
//   BASE=http://localhost:3012 CONTAINER=pdpp-final-uat node scripts/slvp-verify.mjs
//
// Honesty contract: a check that cannot run (no fixture data to exercise it,
// browser step failed) reports UNKNOWN, never a false PASS. Every FAIL prints
// the measured numbers/selectors it failed on, not just a verdict.

import { execFileSync } from "node:child_process";
import { chromium } from "patchright";

const BASE = process.env.BASE || "http://localhost:3012";
const CONTAINER = process.env.CONTAINER || "pdpp-final-uat";
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const JSON_OUT = process.argv.includes("--json");
const STRICT = process.argv.includes("--strict");

const WIDTHS = [320, 390, 768, 1280, 1440, 2560, 3440];
// Sub-pixel layout rounding is normal and invisible; only flag a real bar.
const OVERFLOW_TOLERANCE_PX = 1;
const MIN_TOUCH_TARGET_PX = 44;
const SNAKE_CASE_RE = /\b[a-z]+_[a-z_]+\b/;
const BARE_JSON_RE = /^\s*[[{]"/;

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

// ── route discovery (COVERAGE, not limit-1 sampling) ────────────────────────
// The red-team's structural critique of uat-verify.mjs was as much about
// sampling as about text-matching: every one of its checks reads `limit 1`.
// Enumerate real routes from the live DB instead of hardcoding one connector.
function discoverRoutes() {
  const sources = sql(
    "select connector_instance_id, connector_id, display_name from connector_instances where status='active' order by connector_id"
  );
  const streamCounts = sql(
    "select connector_instance_id, stream, count(*) n from records where deleted=0 group by connector_instance_id, stream order by n desc"
  );
  // Prefer instances whose connector_id diverges from display_name (the class
  // that exposed the /sources/claude-test alias bug) alongside the largest
  // streams by record count, several per class rather than the first.
  const streamsByInstance = new Map();
  for (const row of streamCounts) {
    if (!streamsByInstance.has(row.connector_instance_id)) {
      streamsByInstance.set(row.connector_instance_id, []);
    }
    streamsByInstance.get(row.connector_instance_id).push(row);
  }
  const sourceSample = sources.slice(0, 6);
  const streamDetailTargets = [];
  for (const src of sources) {
    const streams = streamsByInstance.get(src.connector_instance_id) ?? [];
    if (streams.length > 0) {
      streamDetailTargets.push({ ...src, stream: streams[0].stream });
    }
    if (streamDetailTargets.length >= 5) break;
  }
  let recordDetail = null;
  for (const target of streamDetailTargets) {
    const rows = sql(
      `select record_key from records where connector_instance_id='${target.connector_instance_id}' and stream='${target.stream}' and deleted=0 limit 1`
    );
    if (rows.length > 0) {
      recordDetail = { ...target, recordKey: rows[0].record_key };
      break;
    }
  }
  const runs = sql("select run_id from run_history order by started_at desc limit 1");
  return { recordDetail, runId: runs[0]?.run_id ?? null, sourceSample, streamDetailTargets };
}

// ── main ──────────────────────────────────────────────────────────────────
const results = [];
const record = (id, status, detail) => results.push({ detail, id, status });

// The login form's own return_to defaults to /owner/login, so a successful
// sign-in re-renders that same URL as the signed-in owner dashboard rather
// than navigating away — URL alone cannot distinguish success from failure.
// Check for the password field instead: present only on the signed-out form.
async function isSignedOut(page) {
  return (await page.locator('input[type="password"]').count()) > 0;
}

async function login(page) {
  await page.goto(`${BASE}/owner/login`);
  await page.fill('input[type="password"]', ownerPassword());
  await Promise.all([page.waitForLoadState("networkidle"), page.click('button[type="submit"]')]);
  if (await isSignedOut(page)) {
    throw new Error("login did not authenticate — password field still present after submit (bad password or CSRF mismatch)");
  }
}

async function goto(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  if (path !== "/owner/login" && page.url().includes("/owner/login") && (await isSignedOut(page))) {
    throw new Error(`session lapsed navigating to ${path} (redirected to login)`);
  }
}

// Check 1 — OVERLAP: no two text-bearing elements intersect.
//
// The known P0 (.rr-s-stream vs .rr-s-stream-subfact on /sources) is NOT a
// same-parent sibling pair — each sits in its own table-cell <span>, so the
// two are cousins under a shared grid row, not children of a shared parent.
// A same-parent-only scan misses it structurally. Instead: collect every
// "leaf" text-bearing element on the page (an element with its own text that
// contains no other text-bearing element), then compare ALL such leaves
// pairwise, skipping ancestor/descendant pairs (containment is not overlap).
async function checkOverlap(page, path) {
  const overlaps = await page.evaluate(() => {
    function hasOwnText(el) {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0) return true;
      }
      return false;
    }
    function rectsIntersect(a, b) {
      return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    }
    function describe(el) {
      const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
      return `${el.tagName.toLowerCase()}${cls}`;
    }

    // A "leaf" text element: has its own text node AND no descendant that
    // also carries its own text (otherwise every ancestor of a text span
    // would also count, producing pairs whose "overlap" is pure containment).
    //
    // checkVisibility() (not just getClientRects().length / display/visibility)
    // is required: content inside a CLOSED <details> keeps a non-zero,
    // stale getBoundingClientRect() in Chromium even though it renders
    // nothing — exactly the false "overlap" the 2026-08-08 red-team pass
    // hit on /deployment and had to manually discard. checkVisibility()
    // is the one signal that correctly reports false for that case.
    const candidates = document.querySelectorAll("body *");
    const leaves = [];
    for (const el of candidates) {
      if (!hasOwnText(el)) continue;
      const hasTextDescendant = Array.from(el.querySelectorAll("*")).some(hasOwnText);
      if (hasTextDescendant) continue;
      if (el.getClientRects().length === 0) continue;
      if (typeof el.checkVisibility === "function" && !el.checkVisibility()) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      leaves.push(el);
    }

    const found = [];
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        const elA = leaves[i];
        const elB = leaves[j];
        if (elA.contains(elB) || elB.contains(elA)) continue; // containment, not overlap
        const a = elA.getBoundingClientRect();
        const b = elB.getBoundingClientRect();
        if (a.width === 0 || a.height === 0 || b.width === 0 || b.height === 0) continue;
        if (rectsIntersect(a, b)) {
          found.push({
            rectA: { bottom: a.bottom, left: a.left, right: a.right, top: a.top },
            rectB: { bottom: b.bottom, left: b.left, right: b.right, top: b.top },
            selectorA: describe(elA),
            selectorB: describe(elB),
          });
        }
      }
    }
    return found;
  });
  if (overlaps.length === 0) {
    record(`overlap.${path}`, "PASS", "no intersecting text-bearing elements");
    return;
  }
  for (const o of overlaps.slice(0, 10)) {
    record(
      `overlap.${path}`,
      "FAIL",
      `${o.selectorA} rect=${JSON.stringify(o.rectA)} overlaps ${o.selectorB} rect=${JSON.stringify(o.rectB)}`
    );
  }
}

// Check 2 — HORIZONTAL OVERFLOW at each breakpoint width.
async function checkOverflow(page, path) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ height: 900, width });
    await goto(page, path);
    const { overflow, scrollWidth } = await page.evaluate(() => {
      const d = document.documentElement;
      return { overflow: d.scrollWidth - d.clientWidth, scrollWidth: d.scrollWidth };
    });
    record(
      `overflow.${path}@${width}`,
      overflow > OVERFLOW_TOLERANCE_PX ? "FAIL" : "PASS",
      `scrollWidth=${scrollWidth} overflow=${overflow}px at ${width}px`
    );
  }
  await page.setViewportSize({ height: 900, width: 1280 });
}

// Check 3 — TOUCH TARGETS: every interactive element >= 44x44.
async function checkTouchTargets(page, path) {
  const undersized = await page.evaluate((min) => {
    const els = document.querySelectorAll('button, a, [role="button"], input');
    const found = [];
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // not rendered
      // checkVisibility() catches content in a CLOSED <details> panel,
      // which keeps a stale non-zero rect in Chromium despite rendering
      // nothing (see the overlap check's comment for the same gotcha).
      if (typeof el.checkVisibility === "function" && !el.checkVisibility()) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (rect.width < min || rect.height < min) {
        const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
        const label = el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 40) || "(no label)";
        found.push({
          height: Math.round(rect.height * 10) / 10,
          label,
          selector: `${el.tagName.toLowerCase()}${cls}`,
          width: Math.round(rect.width * 10) / 10,
        });
      }
    }
    return found;
  }, MIN_TOUCH_TARGET_PX);
  if (undersized.length === 0) {
    record(`touch-targets.${path}`, "PASS", `all interactive elements >= ${MIN_TOUCH_TARGET_PX}px`);
    return;
  }
  for (const t of undersized.slice(0, 15)) {
    record(
      `touch-targets.${path}`,
      "FAIL",
      `${t.selector} "${t.label}" is ${t.width}x${t.height}px (< ${MIN_TOUCH_TARGET_PX}px bar)`
    );
  }
}

// Check 4 — RAW JARGON IN RENDERED TEXT: snake_case identifiers, bare JSON.
async function checkJargon(page, path) {
  const hits = await page.evaluate(
    ({ bareJson, snakeCase }) => {
      const snakeRe = new RegExp(snakeCase);
      const jsonRe = new RegExp(bareJson);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const found = [];
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent.trim();
        if (text.length > 0 && (snakeRe.test(text) || jsonRe.test(text))) {
          const parentEl = node.parentElement;
          const rect = parentEl?.getBoundingClientRect();
          const visible =
            parentEl && (typeof parentEl.checkVisibility !== "function" || parentEl.checkVisibility());
          if (rect && rect.width > 0 && rect.height > 0 && visible) {
            found.push({ text: text.slice(0, 120) });
          }
        }
        node = walker.nextNode();
      }
      return found;
    },
    { bareJson: BARE_JSON_RE.source, snakeCase: SNAKE_CASE_RE.source }
  );
  if (hits.length === 0) {
    record(`jargon.${path}`, "PASS", "no snake_case identifiers or bare JSON in visible text");
    return;
  }
  const seen = new Set();
  for (const h of hits) {
    if (seen.has(h.text)) continue;
    seen.add(h.text);
    record(`jargon.${path}`, "FAIL", `visible text: "${h.text}"`);
    if (seen.size >= 15) break;
  }
}

// Check 5 — ACCESSIBILITY BASICS.
async function checkAccessibility(page, path) {
  const a11y = await page.evaluate(() => {
    const iconOnlyNoName = [];
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const textContent = el.textContent?.trim() ?? "";
      const ariaLabel = el.getAttribute("aria-label")?.trim();
      const ariaLabelledBy = el.getAttribute("aria-labelledby");
      const title = el.getAttribute("title")?.trim();
      const hasAccessibleName = Boolean(ariaLabel || ariaLabelledBy || title || textContent);
      if (!hasAccessibleName) {
        const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
        iconOnlyNoName.push(`${el.tagName.toLowerCase()}${cls}`);
      }
    }
    const h1Count = document.querySelectorAll("h1").length;
    return { h1Count, iconOnlyNoName };
  });
  record(
    `a11y.icon-only-name.${path}`,
    a11y.iconOnlyNoName.length === 0 ? "PASS" : "FAIL",
    a11y.iconOnlyNoName.length === 0
      ? "every interactive element has an accessible name"
      : `no accessible name: ${a11y.iconOnlyNoName.slice(0, 10).join(", ")}`
  );
  record(
    `a11y.single-h1.${path}`,
    a11y.h1Count === 1 ? "PASS" : "FAIL",
    `h1 count on page: ${a11y.h1Count}`
  );

  // Visible focus after tabbing: focus the first interactive element and
  // check the browser actually rendered a visible focus indicator (outline
  // or box-shadow), not just that focus moved.
  try {
    await page.keyboard.press("Tab");
    const focusState = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { focused: false };
      const style = getComputedStyle(el);
      const hasOutline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
      const hasBoxShadow = style.boxShadow !== "none" && style.boxShadow !== "";
      return { focused: true, hasOutline: hasOutline || hasBoxShadow, tag: el.tagName.toLowerCase() };
    });
    if (!focusState.focused) {
      record(`a11y.visible-focus.${path}`, "UNKNOWN", "Tab did not move focus off <body>");
    } else {
      record(
        `a11y.visible-focus.${path}`,
        focusState.hasOutline ? "PASS" : "FAIL",
        focusState.hasOutline
          ? `${focusState.tag} shows a visible focus indicator`
          : `${focusState.tag} has no outline/box-shadow after Tab`
      );
    }
  } catch (err) {
    record(`a11y.visible-focus.${path}`, "UNKNOWN", `focus probe threw: ${err.message}`);
  }
}

async function checkPage(page, path) {
  try {
    await page.setViewportSize({ height: 900, width: 1280 });
    await goto(page, path);
    await checkOverlap(page, path);
    await checkTouchTargets(page, path);
    await checkJargon(page, path);
    await checkAccessibility(page, path);
    await checkOverflow(page, path); // last: it changes viewport width per-breakpoint
  } catch (err) {
    record(`page.${path}`, "UNKNOWN", `checks could not run: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let browser;
try {
  const routes = discoverRoutes();

  browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: CHROME_PATH, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page);

  const targets = [
    "/",
    "/sources",
    "/syncs",
    "/audit",
    "/deployment",
    "/grants",
    "/explore",
    "/schedules",
    "/connect",
    ...routes.sourceSample.map((s) => `/sources/${s.connector_instance_id}`),
    ...routes.streamDetailTargets.map((s) => `/sources/${s.connector_instance_id}/${s.stream}`),
  ];
  if (routes.recordDetail) {
    targets.push(`/sources/${routes.recordDetail.connector_instance_id}/${routes.recordDetail.stream}/${routes.recordDetail.recordKey}`);
  } else {
    record("coverage.record-detail", "UNKNOWN", "no record with a stream+recordKey found to sample");
  }
  if (routes.runId) {
    targets.push(`/syncs/${routes.runId}`);
  } else {
    record("coverage.run-detail", "UNKNOWN", "no run in run_history to sample");
  }
  if (routes.streamDetailTargets.length === 0) {
    record("coverage.stream-detail", "UNKNOWN", "no connector instance had any records to derive a stream route from");
  }

  for (const path of targets) {
    await checkPage(page, path);
  }

  await browser.close();
  browser = null;
} catch (err) {
  record("harness", "FAIL", err instanceof Error ? err.message : String(err));
  if (browser) await browser.close().catch(() => {});
}

// ── report ───────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === "FAIL");
const unknown = results.filter((r) => r.status === "UNKNOWN");
const passed = results.filter((r) => r.status === "PASS");

if (JSON_OUT) {
  console.log(JSON.stringify({ failed: failed.length, results, unknown: unknown.length }, null, 2));
} else {
  console.log("# slvp-verify — rendered-DOM checks (needs a browser; opt-in/nightly, not hermetic)\n");
  for (const r of results) {
    console.log(`${r.status.padEnd(7)} ${r.id.padEnd(50)} ${r.detail}`);
  }
  console.log(`\n${passed.length} pass, ${failed.length} fail, ${unknown.length} unknown (${results.length} total checks)`);
}
process.exit(STRICT && failed.length > 0 ? 1 : 0);
