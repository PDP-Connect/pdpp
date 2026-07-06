// Raw-CDP fingerprint probe. Connects directly via WebSocket to the
// neko Chromium's CDP endpoint and dumps the highest-signal bot-detection
// values from inside a page context. Use this to verify the binary
// + launch-arg layer of stealth in isolation from Patchright.
//
// Usage from inside the reference container:
//   node scripts/stealth/fingerprint-probe.ts

const CDP = process.env.NEKO_CDP || "http://neko:9223";

interface CdpTarget {
  type?: string;
  webSocketDebuggerUrl?: string;
}

async function getWsUrl() {
  const tgtRes = await fetch(`${CDP}/json`);
  const targets = (await tgtRes.json()) as CdpTarget[];
  const page = targets.find((t) => t.type === "page") || targets[0];
  return page?.webSocketDebuggerUrl;
}

interface CdpResult {
  error?: { message: string };
  id?: number;
  result?: unknown;
}

function cdp(ws: WebSocket, method: string, params: unknown = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (ev: MessageEvent) => {
      const msg = JSON.parse(ev.data as string) as CdpResult;
      if (msg.id !== id) {
        return;
      }
      ws.removeEventListener("message", onMsg);
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws: WebSocket, expression: string) {
  const res = (await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as {
    exceptionDetails?: { text: string };
    result?: { value: unknown };
  };
  if (res.exceptionDetails) {
    return { error: res.exceptionDetails.text };
  }
  return res.result?.value;
}

const wsUrl = await getWsUrl();
console.log("== target ws ==", wsUrl);
if (!wsUrl) {
  throw new Error("no CDP target with a webSocketDebuggerUrl found");
}
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});

const probes = {
  "navigator.webdriver": "navigator.webdriver",
  "navigator.userAgent": "navigator.userAgent",
  "navigator.platform": "navigator.platform",
  "navigator.languages": "JSON.stringify(navigator.languages)",
  "navigator.plugins.length": "navigator.plugins.length",
  "navigator.hardwareConcurrency": "navigator.hardwareConcurrency",
  "navigator.deviceMemory": "navigator.deviceMemory",
  "window.chrome exists": "typeof window.chrome",
  "window.chrome.runtime exists": "typeof window.chrome?.runtime",
  "WebGL VENDOR":
    "(() => { const g = document.createElement('canvas').getContext('webgl'); const e = g.getExtension('WEBGL_debug_renderer_info'); return g.getParameter(e.UNMASKED_VENDOR_WEBGL); })()",
  "WebGL RENDERER":
    "(() => { const g = document.createElement('canvas').getContext('webgl'); const e = g.getExtension('WEBGL_debug_renderer_info'); return g.getParameter(e.UNMASKED_RENDERER_WEBGL); })()",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional — this string is a JS source expression evaluated inside the browser page via Runtime.evaluate, not a JS-side template literal.
  "screen.width x height": "`${screen.width}x${screen.height}`",
  devicePixelRatio: "window.devicePixelRatio",
  "Runtime injected token (cdc_)":
    "(() => { const s = Object.keys(window).join('|') + '|' + Object.keys(document).join('|'); return /cdc_/.test(s); })()",
};

console.log("\n== fingerprint signals ==");
for (const [name, expr] of Object.entries(probes)) {
  const v = await evaluate(ws, expr);
  console.log(`  ${name.padEnd(38)} = ${JSON.stringify(v)}`);
}
ws.close();
