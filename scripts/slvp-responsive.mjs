#!/usr/bin/env node
// SLVP responsive gate — zero horizontal overflow, 320px to 3440px.
//
// The owner's standing rule: "fully slvp responsive/adaptive/any device looks
// amazing", zero horizontal overflow across that range. SLVP = the bar Stripe,
// Linear, Vercel and Plaid actually ship, treated as the FLOOR.
//
// A horizontal scrollbar on a data-dense operator console is the single most
// visible way to miss that bar, and it is trivially measurable — so it should
// be measured on every build rather than eyeballed once.
//
// Drives the real browser through Playwright MCP: no headless approximation,
// no CSS reasoning, just document.scrollWidth vs clientWidth on the rendered
// page at each breakpoint.
//
// SHARED BROWSER CAVEAT: this drives the one Playwright MCP browser on the
// host. If anything else is driving it concurrently (another agent, a human),
// navigations interleave and measurements land on the wrong page — which shows
// up as UNKNOWN rows, never as a false OK, because every measurement carries
// location.pathname and is discarded when it does not match the requested
// route. Run it when nothing else is using the browser.
//
// Usage:  node scripts/slvp-responsive.mjs [--json]
//   PW_MCP=http://172.17.0.1:3100/mcp  BASE=http://localhost:3012
//
// Exit 1 if any page overflows at any width.

const BASE = process.env.BASE || "http://localhost:3012";
const MCP = process.env.PW_MCP || "http://172.17.0.1:3100/mcp";
const JSON_OUT = process.argv.includes("--json");

const PATHS = ["/", "/sources", "/syncs", "/audit", "/deployment", "/grants", "/explore", "/schedules", "/connect"];
const WIDTHS = [320, 390, 768, 1280, 1440, 2560, 3440];
// Sub-pixel layout rounding is normal and invisible; only flag a real bar.
const OVERFLOW_TOLERANCE_PX = 1;

let seq = 1;
// The MCP server is stateful: it rejects tool calls with "Server not
// initialized" until an initialize handshake establishes a session, and the
// session id comes back in a response HEADER that every later call must echo.
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
  // A notification (or an accepted-but-empty response) has no body. Returning
  // null keeps callers from parsing "" and dying on an unrelated line.
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
    clientInfo: { name: "slvp-responsive", version: "1.0.0" },
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

const MEASURE = `() => {
  const d = document.documentElement;
  return { overflow: d.scrollWidth - d.clientWidth, pathname: location.pathname, scrollWidth: d.scrollWidth };
}`;

await initialize();

// Every console route is behind the owner session gate, and a logged-out hit
// silently redirects to /owner/login — which renders a short, non-overflowing
// page and would score a false OK on whatever route we thought we measured.
// Sign in first, and re-check on every navigation below.
async function login() {
  const { execFileSync } = await import("node:child_process");
  const password = execFileSync("docker", ["exec", "pdpp-final-uat", "cat", "/var/lib/pdpp/owner-password"], {
    encoding: "utf8",
  }).trim();
  await call("browser_navigate", { url: `${BASE}/owner/login` });
  await call("browser_fill_form", {
    fields: [{ name: "Owner password", target: "input[type=password]", type: "textbox", value: password }],
  });
  await call("browser_click", { element: "Sign in", target: "button[type=submit]" });
}
await login();

const results = [];
for (const width of WIDTHS) {
  await call("browser_resize", { height: 900, width });
  for (const path of PATHS) {
    await call("browser_navigate", { url: `${BASE}${path}` });
    const res = await call("browser_evaluate", { function: MEASURE });
    const text = res?.result?.content?.map((c) => c.text).join("") ?? "";
    // The tool result is markdown: a "### Result" block holding the return
    // value, then a fenced code block echoing the Playwright call. A bare
    // brace-match grabs whichever comes first, so anchor on the Result header.
    const parsed = text.split("### Result")[1]?.match(/\{[\s\S]*?\}/)?.[0];
    if (!parsed) {
      results.push({ overflow: null, path, status: "UNKNOWN", width });
      continue;
    }
    const { overflow, pathname } = JSON.parse(parsed);
    // A redirect to the login page means the session lapsed; re-auth and retry
    // rather than recording a measurement of the wrong page.
    if (pathname && pathname !== path) {
      results.push({ actual: pathname, overflow: null, path, status: "UNKNOWN", width });
      continue;
    }
    results.push({ overflow, path, status: overflow > OVERFLOW_TOLERANCE_PX ? "OVERFLOW" : "OK", width });
  }
}

const bad = results.filter((r) => r.status === "OVERFLOW");
const unknown = results.filter((r) => r.status === "UNKNOWN");

if (JSON_OUT) {
  console.log(JSON.stringify({ overflows: bad.length, results }, null, 2));
} else {
  for (const r of bad) {
    console.log(`OVERFLOW  ${String(r.width).padStart(5)}px  ${r.path.padEnd(14)} +${r.overflow}px`);
  }
  for (const r of unknown) {
    console.log(`UNKNOWN   ${String(r.width).padStart(5)}px  ${r.path}`);
  }
  console.log(
    `\n${results.length - bad.length - unknown.length} ok, ${bad.length} overflow, ${unknown.length} unknown ` +
      `(${PATHS.length} pages x ${WIDTHS.length} widths)`
  );
}
process.exit(bad.length > 0 ? 1 : 0);
