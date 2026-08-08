#!/usr/bin/env node
// SLVP overlap gate — no two text elements within a table row may occupy
// overlapping screen space, 320px to 3440px.
//
// `scripts/slvp-responsive.mjs` measures horizontal OVERFLOW (scrollWidth vs
// clientWidth) but cannot see overlap: two elements sitting on top of each
// other change neither. The live P0 this closes — the `/sources` per-source
// streams table's stream name (`.rr-s-stream`) rendering directly on top of
// its subfact (`.rr-s-stream-subfact`) at the DEFAULT 1280px desktop width,
// zero zoom, zero interaction — passed `slvp-responsive.mjs` and every
// text-presence check in `scripts/uat-verify.mjs` cleanly, because the text
// was present and correctly ordered in the DOM; it just visually collided.
// This is a real measured getBoundingClientRect() check for exactly that
// class of bug, not a class-name/CSS snapshot (a class-name assertion would
// not have caught the live defect — the classes were already correct).
//
// Drives the real browser through Playwright MCP, same protocol/auth flow as
// slvp-responsive.mjs.
//
// Usage:  node scripts/slvp-overlap.mjs [--json]
//   PW_MCP=http://172.17.0.1:3100/mcp  BASE=http://localhost:3012
//
// Exit 1 if any two elements within the same table row overlap at any width.

const BASE = process.env.BASE || "http://localhost:3012";
const MCP = process.env.PW_MCP || "http://172.17.0.1:3100/mcp";
const JSON_OUT = process.argv.includes("--json");

// Each row-scoped check: a page path, a row selector, and the text-bearing
// child elements within that row that must never overlap each other. Starts
// with the `/sources` streams table (the live P0); extend this list as new
// dense-row surfaces ship rather than writing one script per page.
const CHECKS = [
  {
    children: [".rr-s-stream", ".rr-s-stream-fact", ".rr-s-stream-subfact", ".rr-s-stream-chip"],
    path: "/sources",
    row: ".rr-s-stream-row",
  },
];

const WIDTHS = [320, 390, 768, 1024, 1280, 1440, 1920, 2560, 3440];

let seq = 1;
let sessionId = null;

async function rpc(method, params) {
  const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  const res = await fetch(MCP, {
    body: JSON.stringify({ id: seq++, jsonrpc: "2.0", method, params }),
    headers,
    method: "POST",
  });
  const returned = res.headers.get("mcp-session-id");
  if (returned) {
    sessionId = returned;
  }
  const text = await res.text();
  if (!text.trim()) {
    return null;
  }
  const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
  try {
    return JSON.parse(line.replace(/^data: /, ""));
  } catch {
    return null;
  }
}

async function initialize() {
  await rpc("initialize", {
    capabilities: {},
    clientInfo: { name: "slvp-overlap", version: "1.0.0" },
    protocolVersion: "2024-11-05",
  });
  await fetch(MCP, {
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    method: "POST",
  });
}

const call = (name, args) => rpc("tools/call", { arguments: args, name });

// Returns, per row, the measured rect of each present child selector (a
// selector absent from a given row — e.g. no chip on a stream with no
// collection report — is simply omitted, not a zero rect) plus the page
// pathname so a lapsed-session redirect is detectable.
function measureFn(rowSelector, childSelectors) {
  return `() => {
    const rows = Array.from(document.querySelectorAll(${JSON.stringify(rowSelector)}));
    const rects = rows.map((row) => {
      const found = {};
      for (const sel of ${JSON.stringify(childSelectors)}) {
        const els = Array.from(row.querySelectorAll(sel));
        found[sel] = els.map((el) => {
          const r = el.getBoundingClientRect();
          return { bottom: r.bottom, left: r.left, right: r.right, top: r.top };
        });
      }
      return found;
    });
    return { pathname: location.pathname, rects };
  }`;
}

function rectsIntersect(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function login() {
  const { execFileSync } = await import("node:child_process");
  const password = execFileSync("docker", ["exec", "pdpp-final-uat", "cat", "/var/lib/pdpp/owner-password"], {
    encoding: "utf8",
  }).trim();
  await call("browser_navigate", { url: `${BASE}/owner/login` });
  // The login form is a client component that mounts after navigation
  // settles; filling immediately intermittently races it and misses the
  // input. A short settle avoids a flaky UNKNOWN on an otherwise-working run.
  await sleep(1000);
  await call("browser_fill_form", {
    fields: [{ name: "Owner password", target: "input[type=password]", type: "textbox", value: password }],
  });
  await sleep(300);
  await call("browser_click", { element: "Sign in", target: "button[type=submit]" });
  await sleep(1200);
}

await initialize();
await login();

const results = [];
for (const width of WIDTHS) {
  await call("browser_resize", { height: 900, width });
  for (const check of CHECKS) {
    await call("browser_navigate", { url: `${BASE}${check.path}` });
    const res = await call("browser_evaluate", { function: measureFn(check.row, check.children) });
    const text = res?.result?.content?.map((c) => c.text).join("") ?? "";
    // The tool result is markdown: a "### Result" block holding the JSON
    // return value, followed by a "### ..." section echoing the Playwright
    // call (which itself contains braces from the stringified function, so a
    // greedy brace match must stop at the section boundary, not the last "}"
    // in the whole payload).
    const afterResult = text.split("### Result")[1] ?? "";
    const beforeNextSection = afterResult.split(/\n### /)[0] ?? "";
    const parsed = beforeNextSection.match(/\{[\s\S]*\}/)?.[0];
    if (!parsed) {
      results.push({ path: check.path, status: "UNKNOWN", width });
      continue;
    }
    const { pathname, rects } = JSON.parse(parsed);
    if (pathname && pathname !== check.path) {
      results.push({ actual: pathname, path: check.path, status: "UNKNOWN", width });
      continue;
    }
    let overlapCount = 0;
    for (const [rowIndex, bySelector] of rects.entries()) {
      const flat = Object.entries(bySelector).flatMap(([sel, list]) => list.map((rect) => ({ rect, sel })));
      for (let i = 0; i < flat.length; i += 1) {
        for (let j = i + 1; j < flat.length; j += 1) {
          if (flat[i].sel === flat[j].sel) {
            continue; // Two siblings sharing a selector (e.g. two chips) may legitimately sit apart or stack; only cross-selector pairs are checked.
          }
          if (rectsIntersect(flat[i].rect, flat[j].rect)) {
            overlapCount += 1;
            results.push({
              a: { rect: flat[i].rect, sel: flat[i].sel },
              b: { rect: flat[j].rect, sel: flat[j].sel },
              path: check.path,
              row: rowIndex,
              status: "OVERLAP",
              width,
            });
          }
        }
      }
    }
    if (overlapCount === 0 && rects.length > 0) {
      results.push({ path: check.path, rows: rects.length, status: "OK", width });
    }
  }
}

const bad = results.filter((r) => r.status === "OVERLAP");
const unknown = results.filter((r) => r.status === "UNKNOWN");

if (JSON_OUT) {
  console.log(JSON.stringify({ overlaps: bad.length, results }, null, 2));
} else {
  for (const r of bad) {
    console.log(
      `OVERLAP  ${String(r.width).padStart(5)}px  ${r.path} row ${r.row}  ${r.a.sel} x ${r.b.sel}\n` +
        `  ${r.a.sel}: top:${r.a.rect.top} bottom:${r.a.rect.bottom} left:${r.a.rect.left} right:${r.a.rect.right}\n` +
        `  ${r.b.sel}: top:${r.b.rect.top} bottom:${r.b.rect.bottom} left:${r.b.rect.left} right:${r.b.rect.right}`
    );
  }
  for (const r of unknown) {
    console.log(`UNKNOWN  ${String(r.width).padStart(5)}px  ${r.path}`);
  }
  const ok = results.filter((r) => r.status === "OK").length;
  console.log(`\n${ok} ok, ${bad.length} overlap, ${unknown.length} unknown (${WIDTHS.length} widths)`);
}
process.exit(bad.length > 0 ? 1 : 0);
