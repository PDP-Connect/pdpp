#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const HELP = `Usage:
  node scripts/inspect-browser-run.mjs --neko-container <name> [options]

Options:
  --neko-container <name>       n.eko container that owns the live browser.
  --page-url <substring>        Prefer a page target whose URL includes this text.
  --cdp-port <port>             Host-reachable CDP HTTP port inside the container network (default: 9223).
  --body-preview <chars>        Max body text preview from Runtime.evaluate (default: 800).
  --node-container <name>       Container that owns the connector Node process.
  --node-pid <pid>              Connector Node PID to inspect.
  --enable-node-inspector       Send SIGUSR1 to --node-pid, sample handles/stack, then close inspector.
  --help                        Show this help.

This script is read-only for browser CDP. Node inspection is opt-in because it
briefly enables the target process's inspector and pauses/resumes it once.
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

if (!args.nekoContainer) {
  die("--neko-container is required");
}

const result = {
  inspected_at: new Date().toISOString(),
  neko_container: args.nekoContainer,
  browser: null,
  node: null,
  notes: [],
};

try {
  result.browser = await inspectBrowser(args);
} catch (error) {
  result.browser = { ok: false, error: errorMessage(error) };
}

if (args.enableNodeInspector || args.nodePid || args.nodeContainer) {
  if (!(args.enableNodeInspector && args.nodePid && args.nodeContainer)) {
    result.node = {
      ok: false,
      error: "--enable-node-inspector requires both --node-container and --node-pid",
    };
  } else {
    try {
      result.node = inspectNodeProcess({
        container: args.nodeContainer,
        pid: args.nodePid,
      });
    } catch (error) {
      result.node = { ok: false, error: errorMessage(error) };
    }
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

async function inspectBrowser(options) {
  const ip = dockerInspectIp(options.nekoContainer);
  const cdpPort = options.cdpPort ?? "9223";
  const cdpBase = `http://${ip}:${cdpPort}`;
  const version = await fetchJson(`${cdpBase}/json/version`, 3_000);
  const targets = await fetchJson(`${cdpBase}/json/list`, 3_000);
  const pageTargets = targets.filter((target) => target.type === "page");
  const selected =
    pageTargets.find((target) => options.pageUrl && target.url.includes(options.pageUrl)) ??
    pageTargets.find((target) => !options.pageUrl && target.url.startsWith("https://")) ??
    pageTargets[0] ??
    null;

  const summary = {
    ok: true,
    ip,
    cdp_base: cdpBase,
    version: pick(version, ["Browser", "Protocol-Version", "User-Agent"]),
    targets: targets.map((target) => ({
      id: target.id,
      type: target.type,
      title: target.title,
      url: target.url,
    })),
    selected_target: selected
      ? { id: selected.id, title: selected.title, url: selected.url, type: selected.type }
      : null,
    probes: null,
  };

  if (!selected) {
    return summary;
  }

  const wsUrl = selected.webSocketDebuggerUrl;
  const expression = pageDiagnosticExpression(Number(options.bodyPreview ?? 800));
  const probes = await cdpBatch(wsUrl, [
    { method: "Page.getNavigationHistory" },
    { method: "Page.getFrameTree" },
    { method: "DOM.getDocument", params: { depth: 1, pierce: false } },
    {
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    },
  ]);
  summary.probes = probes;
  return summary;
}

function inspectNodeProcess({ container, pid }) {
  const source = `
const pid = ${JSON.stringify(String(pid))};
const cp = await import("node:child_process");
cp.execFileSync("sh", ["-lc", "kill -USR1 " + pid + "; sleep 0.5"], { stdio: "ignore" });
const targets = await fetch("http://127.0.0.1:9229/json/list").then((r) => r.json());
const wsUrl = targets[0]?.webSocketDebuggerUrl;
const result = { ok: true, target: targets[0] ? { title: targets[0].title, url: targets[0].url } : null, handles: null, active_requests: null, paused: null, errors: [] };
if (!wsUrl) {
  result.ok = false;
  result.errors.push("no inspector target");
  console.log(JSON.stringify(result));
  process.exit(0);
}
let id = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);
function send(method, params = {}, timeoutMs = 5000) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(msgId)) {
        pending.delete(msgId);
        reject(new Error(method + " timeout"));
      }
    }, timeoutMs);
    pending.set(msgId, { method, resolve, reject, timer });
  });
}
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", (event) => reject(new Error(String(event.message || event.type || event))), { once: true });
});
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data.toString());
  if (msg.id && pending.has(msg.id)) {
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(entry.method + ": " + JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
    return;
  }
  if (msg.method === "Debugger.paused") {
    result.paused = {
      reason: msg.params?.reason,
      call_frames: (msg.params?.callFrames ?? []).slice(0, 24).map((frame) => ({
        function_name: frame.functionName,
        url: frame.url,
        line: frame.location?.lineNumber,
        col: frame.location?.columnNumber,
      })),
      async_stack: msg.params?.asyncStackTrace
        ? {
            description: msg.params.asyncStackTrace.description,
            call_frames: (msg.params.asyncStackTrace.callFrames ?? []).slice(0, 24).map((frame) => ({
              function_name: frame.functionName,
              url: frame.url,
              line: frame.lineNumber,
              col: frame.columnNumber,
            })),
          }
        : null,
    };
  }
});
try {
  await send("Runtime.enable");
  await send("Debugger.enable");
  await send("Debugger.setAsyncCallStackDepth", { maxDepth: 12 });
  result.handles = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: \`(() => process._getActiveHandles().map((handle) => ({
      ctor: handle?.constructor?.name,
      fd: handle?.fd,
      readable: handle?.readable,
      writable: handle?.writable,
      destroyed: handle?.destroyed,
      local: handle?.localAddress ? handle.localAddress + ":" + handle.localPort : undefined,
      remote: handle?.remoteAddress ? handle.remoteAddress + ":" + handle.remotePort : undefined,
      timeout: handle?._idleTimeout,
    })))()\`,
  })).result?.value;
  result.active_requests = (await send("Runtime.evaluate", {
    returnByValue: true,
    expression: \`(() => process._getActiveRequests().map((request) => ({ ctor: request?.constructor?.name })))()\`,
  })).result?.value;
  await send("Debugger.pause");
  const start = Date.now();
  while (!result.paused && Date.now() - start < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!result.paused) result.errors.push("pause event not observed within 5s");
  await send("Debugger.resume", {}, 3000).catch((error) => result.errors.push("resume: " + error.message));
} catch (error) {
  result.ok = false;
  result.errors.push(error?.message ?? String(error));
} finally {
  await send("Runtime.evaluate", { expression: "import('node:inspector').then((m) => m.close())", awaitPromise: true }, 3000).catch(() => {});
  try { ws.close(); } catch {}
  console.log(JSON.stringify(result));
}
`;
  const stdout = execFileSync("docker", ["exec", "-i", container, "node", "--input-type=module"], {
    encoding: "utf8",
    input: source,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim() || "{}");
}

function pageDiagnosticExpression(bodyPreview) {
  return `(() => {
    const body = document.body?.innerText || "";
    const selectors = [
      "form[name=\\"signIn\\"]",
      "#orderTypeMenuContainer",
      "#yourOrdersHeader",
      "[data-component=\\"orderCardList\\"]",
      ".order-card",
      ".js-order-card",
      "#ordersContainer",
      "#no-orders",
      "input[type=\\"password\\"]",
      "input[type=\\"email\\"]",
      "iframe"
    ];
    return {
      url: location.href,
      title: document.title,
      ready_state: document.readyState,
      body_preview: body.replace(/\\s+/g, " ").slice(0, ${bodyPreview}),
      selector_counts: Object.fromEntries(selectors.map((selector) => [selector, document.querySelectorAll(selector).length])),
      has_captcha_text: /captcha|robot|unusual traffic|enter the characters/i.test(body),
      has_signin_text: /sign in|email or mobile phone number|password/i.test(body),
      has_orders_text: /your orders|orders placed|buy again|order placed/i.test(body),
      frame_count: window.frames.length,
      active_element: {
        tag: document.activeElement?.tagName,
        type: document.activeElement?.getAttribute("type")
      }
    };
  })()`;
}

async function cdpBatch(wsUrl, calls) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const results = [];
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", (event) => reject(new Error(String(event.message || event.type || event))), {
      once: true,
    });
  });

  const done = new Promise((resolve) => {
    const overall = setTimeout(() => {
      for (const [id, call] of pending) {
        results.push({ method: call.method, ok: false, timed_out: true });
        pending.delete(id);
      }
      resolve();
    }, 8_000);

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (!pending.has(message.id)) {
        return;
      }
      const call = pending.get(message.id);
      pending.delete(message.id);
      results.push({
        method: call.method,
        ok: !message.error,
        ...(message.error ? { error: message.error } : { result: summarizeCdpResult(message.result) }),
      });
      if (pending.size === 0) {
        clearTimeout(overall);
        resolve();
      }
    });

    for (const call of calls) {
      const id = nextId++;
      pending.set(id, call);
      ws.send(JSON.stringify({ id, method: call.method, params: call.params ?? {} }));
    }
  });

  await done;
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  return results;
}

function summarizeCdpResult(result) {
  if (!result) {
    return result;
  }
  if (result.entries) {
    return {
      current_index: result.currentIndex,
      entries: result.entries.slice(-8).map((entry) => ({
        id: entry.id,
        url: entry.url,
        title: entry.title,
      })),
    };
  }
  if (result.frameTree) {
    return { frame_tree: summarizeFrameTree(result.frameTree) };
  }
  if (result.root) {
    return {
      root: {
        node_id: result.root.nodeId,
        node_name: result.root.nodeName,
        document_url: result.root.documentURL,
        base_url: result.root.baseURL,
        child_node_count: result.root.childNodeCount,
      },
    };
  }
  if (result.result) {
    return { result: result.result.value ?? result.result.description ?? result.result };
  }
  return result;
}

function summarizeFrameTree(tree) {
  return {
    frame: {
      id: tree.frame?.id,
      url: tree.frame?.url,
      name: tree.frame?.name,
      mime_type: tree.frame?.mimeType,
    },
    child_count: tree.childFrames?.length ?? 0,
    children: (tree.childFrames ?? []).slice(0, 6).map(summarizeFrameTree),
  };
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function dockerInspectIp(container) {
  const stdout = execFileSync(
    "docker",
    ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container],
    { encoding: "utf8" }
  ).trim();
  if (!stdout) {
    throw new Error(`could not resolve container IP for ${container}`);
  }
  return stdout;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--enable-node-inspector") {
      parsed.enableNodeInspector = true;
      continue;
    }
    const key = {
      "--neko-container": "nekoContainer",
      "--page-url": "pageUrl",
      "--cdp-port": "cdpPort",
      "--body-preview": "bodyPreview",
      "--node-container": "nodeContainer",
      "--node-pid": "nodePid",
    }[arg];
    if (!key) {
      die(`unknown argument: ${arg}`);
    }
    const value = argv[++i];
    if (!value) {
      die(`${arg} requires a value`);
    }
    parsed[key] = value;
  }
  return parsed;
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
}

function die(message) {
  process.stderr.write(`${message}\n\n${HELP}`);
  process.exit(2);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
