#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Computed-style differ: the cheap truth-check this repo has no other way to
// get. There is no browser test harness here and zero tests render a public
// page, so a refactor that only LOOKS behavior-preserving in JSX can still
// change what a browser paints — a prior agent reverted a correct migration
// for want of exactly this signal.
//
// For a list of routes and viewports, this script points at two already-
// running servers — a baseline and a candidate — and for a fixed set of "key
// element" selectors on each page, captures the bounding box AND a chosen
// set of resolved (computed) CSS properties. It then diffs candidate against
// baseline and prints every element whose box or style values changed.
//
// Usage:
//   node scripts/style-differ.mjs --baseline http://localhost:4123 --candidate http://localhost:4124
//   node scripts/style-differ.mjs --baseline <url> --candidate <url> --routes /,/self-host --out report.json
//   node scripts/style-differ.mjs --baseline <url> --candidate <url> --routes /specification \
//     --assert-display "#nd-toc:1279:900:none,#nd-toc:1280:900:flex,#nd-toc:1281:900:flex"
//
// The last form is the exact command used to check #nd-toc's computed
// `display` on both sides of fumadocs' 1280px collapse breakpoint (see the
// comment above the removed CSS fallback in styles/surfaces/specification.css).
// --assert-display is a SEPARATE code path from the default box/style diff:
// the default diff's collapse filter drops any zero-box element before
// reading its style (correct for box/position comparisons, wrong for a
// display claim — it would silently pass a selector that matched nothing on
// either side, which is exactly the state a collapsed element is in).
// --assert-display never filters on box size, fails loudly if the selector
// matches no element, and checks BOTH baseline and candidate against the
// given expected value at that assertion's own width×height — each entry
// carries its own viewport rather than sharing --viewports, because a
// breakpoint check inherently expects a DIFFERENT value just above and
// below the line. Re-run it against a fresh baseline/candidate pair
// whenever that fallback's removal needs re-proving.
//
// This script makes no product change. It is read-only against whatever two
// servers you point it at.

import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const DEFAULT_ROUTES = ["/", "/specification", "/self-host", "/self-host/coverage", "/participate", "/maintainers"];

const DEFAULT_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

// Elements whose computed style we care about. Selectors are scoped to the
// public concept surface's own data-slot hooks (stable, not styling-derived)
// plus a small set of generic structural tags every route has (h1/h2/h3, nav,
// a, button).
const KEY_SELECTORS = [
  "h1",
  "h2",
  "h3",
  "main",
  "nav",
  "[data-slot=pdpp-editorial-page]",
  "[data-slot=pdpp-editorial-doc]",
  "[data-slot=pdpp-editorial-doc-header]",
  "[data-slot=pdpp-editorial-masthead]",
  "[data-slot=pdpp-editorial-footer]",
  "[data-slot=pdpp-editorial-section]",
  "[data-slot=pdpp-editorial-text]",
  "[data-slot=pdpp-editorial-button]",
  "[data-slot=pdpp-editorial-rail]",
  "[data-slot=pdpp-front-door]",
  "#nd-toc",
  "p",
  "a[href]",
  "button",
];

const COMPUTED_PROPERTIES = [
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "color",
  "display",
  "margin",
  "padding",
];

// Elements matching a selector here (or nested inside one) are dropped from
// capture entirely — noise, not signal. The animated hero block on `/`
// (hero-water-still.tsx) redraws every frame by design, so its box/style
// values are never stable enough to compare.
const DEFAULT_EXCLUDE_SELECTORS = ["[data-slot=pdpp-front-door] [aria-hidden=true]"];

const FLOAT_TOLERANCE_PX = 0.5;

const FLAG_HANDLERS = {
  "--baseline": (args, value) => {
    args.baseline = value;
  },
  "--candidate": (args, value) => {
    args.candidate = value;
  },
  "--routes": (args, value) => {
    args.routes = value.split(",").map((entry) => entry.trim());
  },
  "--viewports": (args, value) => {
    args.viewports = value.split(",").map((entry) => {
      const [name, width, height] = entry.trim().split(":");
      return { name, width: Number(width), height: Number(height ?? width) };
    });
  },
  "--out": (args, value) => {
    args.out = value;
  },
  "--exclude": (args, value) => {
    args.exclude = value.split(",").map((entry) => entry.trim());
  },
  // Each entry is independent: selector:width:height:expectedDisplay. Not
  // tied to --viewports — a display assertion is inherently per-width (the
  // whole point is checking a selector's display AROUND a breakpoint, where
  // adjacent widths expect DIFFERENT values), so folding it into the
  // shared --viewports list (one size, many selectors/assertions) would
  // force every assertion to share the same expected value at every width.
  "--assert-display": (args, value) => {
    args.assertDisplay = value.split(",").map((entry) => {
      const [selector, width, height, expected] = entry.trim().split(":");
      return { expected, selector, viewport: { height: Number(height), width: Number(width) } };
    });
  },
};

function parseArgs(argv) {
  const args = { routes: DEFAULT_ROUTES, viewports: DEFAULT_VIEWPORTS };
  const pairCount = Math.floor(argv.length / 2);
  const pairIndexes = Array.from({ length: pairCount }, (_, i) => i * 2);
  for (const flagIndex of pairIndexes) {
    const handler = FLAG_HANDLERS[argv[flagIndex]];
    handler?.(args, argv[flagIndex + 1]);
  }
  if (!(args.baseline && args.candidate)) {
    throw new Error(
      "Usage: style-differ.mjs --baseline <url> --candidate <url> [--routes /,/self-host] [--out report.json] [--exclude selector,...]"
    );
  }
  return args;
}

// Everything below `PAGE_EVALUATE_HELPERS` up to (not including)
// `captureKeyElements` runs INSIDE the browser page via page.evaluate, which
// only serializes the one function passed to it — not any Node-side helpers
// it references. describeElementPath must stay nested inside
// captureKeyElements for that reason, split into small inner closures to
// keep each piece within the project's cognitive-complexity budget.

// Runs INSIDE the page (passed to page.evaluate, not called from Node).
function captureKeyElements({ selectors, properties, excludeSelectors }) {
  const isExcluded = (el) => excludeSelectors.some((sel) => el.closest(sel));
  const roundToOneDecimal = (value) => Math.round(value * 10) / 10;

  // Builds a stable path from the root of the document to an element, so
  // the same visual element can be matched across two separately-rendered
  // pages even if surrounding markup shifted slightly.
  const indexAmongSameTagSiblings = (current) => {
    const parent = current.parentElement;
    if (!parent) {
      return null;
    }
    const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
    return siblings.length > 1 ? siblings.indexOf(current) + 1 : null;
  };
  const describeOneNode = (current) => {
    const tag = current.tagName.toLowerCase();
    if (current.id) {
      return `${tag}#${current.id}`;
    }
    const slot = current.getAttribute?.("data-slot");
    if (slot) {
      return `${tag}[data-slot=${slot}]`;
    }
    const siblingIndex = indexAmongSameTagSiblings(current);
    return siblingIndex === null ? tag : `${tag}:nth-of-type(${siblingIndex})`;
  };
  const describeElementPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 40) {
      parts.unshift(describeOneNode(node));
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  const readStyles = (el) => {
    const computed = window.getComputedStyle(el);
    return Object.fromEntries(properties.map((prop) => [prop, computed.getPropertyValue(prop)]));
  };
  const toCaptured = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      box: {
        x: roundToOneDecimal(rect.x),
        y: roundToOneDecimal(rect.y),
        width: roundToOneDecimal(rect.width),
        height: roundToOneDecimal(rect.height),
      },
      path: describeElementPath(el),
      styles: readStyles(el),
      text: (el.textContent || "").trim().slice(0, 60),
    };
  };
  const isCollapsed = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0; // off-screen/collapsed — noise, not signal
  };

  const seen = new Set();
  const elements = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (seen.has(el) || isExcluded(el) || isCollapsed(el)) {
        seen.add(el);
        continue;
      }
      seen.add(el);
      elements.push(toCaptured(el));
    }
  }
  return elements;
}

async function captureRoute(page, baseUrl, route, viewport, excludeSelectors) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "networkidle" });
  return await page.evaluate(captureKeyElements, {
    excludeSelectors,
    properties: COMPUTED_PROPERTIES,
    selectors: KEY_SELECTORS,
  });
}

// `captureKeyElements`'s `isCollapsed` filter drops any zero-box element —
// correct for the box/position diff, where a collapsed element's coordinates
// are meaningless, but WRONG for asserting a display value: it discards the
// `display: none` case a collapse assertion exists to observe, so a "0
// diffs" result there proves only that neither side had a non-collapsed
// element, never that both sides actually show `display: none`. This
// separate, narrow evaluator exists for exactly that claim: it does NOT
// filter on box size, and it fails loudly (`exists: false`) instead of
// silently omitting the element if the selector matches nothing at all.
// Runs INSIDE the page (passed to page.evaluate, not called from Node).
function readDisplayAssertion({ selector }) {
  const el = document.querySelector(selector);
  if (!el) {
    return { display: null, exists: false };
  }
  return { display: window.getComputedStyle(el).display, exists: true };
}

async function assertDisplayAtViewport(page, baseUrl, route, viewport, assertion) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(new URL(route, baseUrl).toString(), { waitUntil: "networkidle" });
  return await page.evaluate(readDisplayAssertion, { selector: assertion.selector });
}

function buildDisplayAssertionTasks(routes, assertions) {
  const sides = [
    ["baseline", "baseline"],
    ["candidate", "candidate"],
  ];
  return routes.flatMap((route) =>
    assertions.flatMap((assertion) => sides.map(([sideName, sideKey]) => ({ assertion, route, sideKey, sideName })))
  );
}

function checkDisplayAssertionResult(task, result) {
  const label = `${task.sideName} ${task.route} @ ${task.assertion.viewport.width}x${task.assertion.viewport.height} ${task.assertion.selector}`;
  if (!result.exists) {
    console.log(`FAIL  ${label} — selector matched no element (expected display: ${task.assertion.expected})`);
    return false;
  }
  if (result.display !== task.assertion.expected) {
    console.log(`FAIL  ${label} — display: "${result.display}", expected "${task.assertion.expected}"`);
    return false;
  }
  console.log(`OK    ${label} — display: "${result.display}"`);
  return true;
}

async function runDisplayAssertions(page, args) {
  const tasks = buildDisplayAssertionTasks(args.routes, args.assertDisplay);
  const sideUrls = { baseline: args.baseline, candidate: args.candidate };
  const passResults = await tasks.reduce(async (accPromise, task) => {
    const acc = await accPromise;
    const result = await assertDisplayAtViewport(
      page,
      sideUrls[task.sideKey],
      task.route,
      task.assertion.viewport,
      task.assertion
    );
    return [...acc, checkDisplayAssertionResult(task, result)];
  }, Promise.resolve([]));
  return passResults.filter((passed) => !passed).length;
}

function keyFor(el) {
  // path alone can collide when nth-of-type structure matches but text
  // differs (e.g. two <p> siblings) — text prefix disambiguates.
  return `${el.path}::${el.text}`;
}

function diffBox(baseBox, candBox) {
  const boxDiff = {};
  for (const dim of ["x", "y", "width", "height"]) {
    if (Math.abs(baseBox[dim] - candBox[dim]) > FLOAT_TOLERANCE_PX) {
      boxDiff[dim] = { baseline: baseBox[dim], candidate: candBox[dim] };
    }
  }
  return boxDiff;
}

function diffStyles(baseStyles, candStyles) {
  const styleDiff = {};
  for (const prop of COMPUTED_PROPERTIES) {
    if (baseStyles[prop] !== candStyles[prop]) {
      styleDiff[prop] = { baseline: baseStyles[prop], candidate: candStyles[prop] };
    }
  }
  return styleDiff;
}

function diffMatchedElement(baseEl, candEl) {
  const box = diffBox(baseEl.box, candEl.box);
  const styles = diffStyles(baseEl.styles, candEl.styles);
  const hasDiff = Object.keys(box).length > 0 || Object.keys(styles).length > 0;
  return hasDiff ? { box, path: baseEl.path, styles, text: baseEl.text, type: "changed" } : null;
}

function diffCapture(baselineElements, candidateElements) {
  const baselineByKey = new Map(baselineElements.map((el) => [keyFor(el), el]));
  const candidateByKey = new Map(candidateElements.map((el) => [keyFor(el), el]));

  const diffs = [];
  for (const [key, baseEl] of baselineByKey) {
    const candEl = candidateByKey.get(key);
    if (!candEl) {
      diffs.push({ path: baseEl.path, text: baseEl.text, type: "removed" });
      continue;
    }
    const changed = diffMatchedElement(baseEl, candEl);
    if (changed) {
      diffs.push(changed);
    }
  }
  for (const [key, candEl] of candidateByKey) {
    if (!baselineByKey.has(key)) {
      diffs.push({ path: candEl.path, text: candEl.text, type: "added" });
    }
  }
  return diffs;
}

function formatChangedDiffLines(diff) {
  const boxLines = Object.entries(diff.box).map(([dim, vals]) => `${dim}: ${vals.baseline} -> ${vals.candidate}`);
  const styleLines = Object.entries(diff.styles).map(
    ([prop, vals]) => `${prop}: "${vals.baseline}" -> "${vals.candidate}"`
  );
  return [...boxLines, ...styleLines];
}

function printDiffs(label, diffs, elementCount) {
  if (diffs.length === 0) {
    console.log(`OK    ${label} — ${elementCount} elements, 0 diffs`);
    return;
  }
  console.log(`DIFF  ${label} — ${diffs.length} of ${elementCount} elements differ`);
  for (const diff of diffs) {
    if (diff.type !== "changed") {
      console.log(`  ${diff.type.toUpperCase()}: ${diff.path} "${diff.text}"`);
      continue;
    }
    console.log(`  CHANGED: ${diff.path} "${diff.text}"`);
    for (const line of formatChangedDiffLines(diff)) {
      console.log(`    ${line}`);
    }
  }
}

function buildTasks(routes, viewports) {
  return routes.flatMap((route) => viewports.map((viewport) => ({ route, viewport })));
}

async function runTask(page, args, excludeSelectors, task) {
  const { route, viewport } = task;
  // One `page` instance is reused for every capture (baseline, then
  // candidate, across every task) to avoid spinning up N browser contexts.
  // Playwright serializes commands against a single page regardless, so
  // this `await` chain is genuinely sequential rather than a parallelizable
  // loop body.
  const baselineCapture = await captureRoute(page, args.baseline, route, viewport, excludeSelectors);
  const candidateCapture = await captureRoute(page, args.candidate, route, viewport, excludeSelectors);
  const diffs = diffCapture(baselineCapture, candidateCapture);
  printDiffs(`${route} @ ${viewport.width}x${viewport.height}`, diffs, baselineCapture.length);
  return {
    diffCount: diffs.length,
    diffs,
    elementCount: baselineCapture.length,
    route,
    viewport,
  };
}

async function runTasksSequentially(page, args, excludeSelectors, tasks) {
  return await tasks.reduce(async (accPromise, task) => {
    const acc = await accPromise;
    const result = await runTask(page, args, excludeSelectors, task);
    return [...acc, result];
  }, Promise.resolve([]));
}

function buildReport(args, results) {
  const routes = {};
  for (const result of results) {
    routes[result.route] ??= {};
    routes[result.route][result.viewport.name] = {
      diffCount: result.diffCount,
      diffs: result.diffs,
      elementCount: result.elementCount,
      viewport: result.viewport,
    };
  }
  return { baseline: args.baseline, candidate: args.candidate, routes };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const excludeSelectors = args.exclude ?? DEFAULT_EXCLUDE_SELECTORS;
  const tasks = buildTasks(args.routes, args.viewports);

  const browser = await chromium.launch();
  let results;
  let displayAssertionFailures = 0;
  try {
    const page = await browser.newPage();
    results = await runTasksSequentially(page, args, excludeSelectors, tasks);
    if (args.assertDisplay) {
      displayAssertionFailures = await runDisplayAssertions(page, args);
    }
  } finally {
    await browser.close();
  }

  const report = buildReport(args, results);
  if (args.out) {
    await writeFile(args.out, JSON.stringify(report, null, 2));
    console.log(`\nWrote full report to ${args.out}`);
  }

  if (displayAssertionFailures > 0) {
    console.log(`\n${displayAssertionFailures} display assertion(s) failed.`);
    process.exitCode = 1;
  }

  const totalDiffs = results.reduce((sum, result) => sum + result.diffCount, 0);
  console.log(`\nTotal diffs across all routes/viewports: ${totalDiffs}`);
  if (totalDiffs > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
