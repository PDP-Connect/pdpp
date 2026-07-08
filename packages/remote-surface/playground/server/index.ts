import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  createCdpPlaygroundSurface,
  type CdpPlaygroundSurfaceDriver,
  type InputDispatchTrace,
  type PlaygroundDriverKind,
  type ProbeSnapshot,
} from "./cdp-surface.ts";
import { renderProbePage } from "./probe-page.ts";
import type { FormOverlayCommitOperation } from "../../src/client/form-overlay/index.ts";
import type { RemoteSurfaceFormFieldSnapshot, RemoteSurfaceKeyModifier } from "../../src/protocol/index.ts";

type ClientMessage =
  | { type: "hello" }
  | { type: "set_quality"; quality: number }
  | { type: "resize"; width: number; height: number; deviceScaleFactor: number; mobile: boolean }
  | {
      type: "pointer_click";
      local: { x: number; y: number };
      remote: { x: number; y: number };
      pointerType?: "mouse" | "touch";
    }
  | { type: "click_selector"; selector: string }
  | { type: "raw_key"; key: string; code: string; modifiers?: number }
  | { type: "text_commit"; handler: "ime-commit" | "paste" | "synthetic"; text: string }
  | { type: "keysym"; handler: "raw-keydown" | "synthetic"; key: "Backspace" | "Enter" }
  | { type: "form_overlay_commit"; operations: FormOverlayCommitOperation[] }
  | { type: "clear_probe" }
  | { type: "snapshot" };

type ServerMessage =
  | { type: "ready"; snapshot: ProbeSnapshot }
  | { type: "frame"; data: string; metadata: Record<string, unknown>; byteLength: number; receivedAt: number }
  | { type: "quality"; quality: number }
  | { type: "form_fields"; snapshot: RemoteSurfaceFormFieldSnapshot }
  | { type: "snapshot"; snapshot: ProbeSnapshot }
  | {
      type: "pointer_result";
      intended: { x: number; y: number };
      dispatched: { x: number; y: number };
      observed: { x: number; y: number; target?: Record<string, unknown> } | null;
      pxError: number | null;
      snapshot: ProbeSnapshot;
    }
  | {
      type: "input_result";
      handler: "raw-keydown" | "ime-commit" | "paste" | "synthetic";
      inputPath: string;
      inputPaths: string[];
      telemetry: InputDispatchTrace[];
      text: string;
      key?: string;
      timestamp: number;
      snapshot: ProbeSnapshot;
    }
  | { type: "error"; message: string };

const dirname = path.dirname(fileURLToPath(import.meta.url));
const playgroundRoot = path.resolve(dirname, "..");
const clientRoot = path.join(playgroundRoot, "client");
const packageRoot = path.resolve(playgroundRoot, "..");
const packageDistRoot = path.join(packageRoot, "dist");

function parsePort(): number {
  const portFlagIndex = process.argv.indexOf("--port");
  const raw = portFlagIndex >= 0 ? process.argv[portFlagIndex + 1] : process.env.REMOTE_SURFACE_PLAYGROUND_PORT;
  const parsed = Number(raw ?? 3977);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3977;
}

function parseDriver(): PlaygroundDriverKind {
  const driverFlagIndex = process.argv.indexOf("--driver");
  const raw = driverFlagIndex >= 0
    ? process.argv[driverFlagIndex + 1]
    : process.env.REMOTE_SURFACE_PLAYGROUND_DRIVER;
  return raw === "legacy" ? "legacy" : "package";
}

// Defaults to loopback. Pass --host 0.0.0.0 (or REMOTE_SURFACE_PLAYGROUND_HOST)
// to expose the harness on the LAN for real-device (phone) testing. Only bind a
// non-loopback host on a trusted network — this server dispatches raw input into
// a live Chromium with no auth.
function parseHost(): string {
  const hostFlagIndex = process.argv.indexOf("--host");
  const raw = hostFlagIndex >= 0 ? process.argv[hostFlagIndex + 1] : process.env.REMOTE_SURFACE_PLAYGROUND_HOST;
  return raw && raw.length > 0 ? raw : "127.0.0.1";
}

function lanAddresses(): string[] {
  const nets = networkInterfaces();
  const out: string[] = [];
  for (const iface of Object.values(nets)) {
    for (const info of iface ?? []) {
      if (info.family === "IPv4" && !info.internal) out.push(info.address);
    }
  }
  return out;
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "application/octet-stream";
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/probe") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderProbePage());
    return;
  }
  if (url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname.startsWith("/remote-surface/")) {
    const requestedDist = url.pathname.replace(/^\/remote-surface\//u, "");
    const normalizedDist = path.normalize(requestedDist).replace(/^(\.\.[/\\])+/, "");
    const distPath = path.join(packageDistRoot, normalizedDist);
    if (!distPath.startsWith(packageDistRoot)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    try {
      const fileStat = await stat(distPath);
      if (!fileStat.isFile()) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      res.writeHead(200, { "content-type": contentType(distPath) });
      createReadStream(distPath).pipe(res);
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(clientRoot, normalized);
  if (!filePath.startsWith(clientRoot)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, { "content-type": contentType(filePath) });
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(clients: Set<WebSocket>, message: ServerMessage): void {
  for (const client of clients) {
    send(client, message);
  }
}

function keyToKeysym(key: "Backspace" | "Enter" | "Tab"): number {
  if (key === "Backspace") return 0xff08;
  if (key === "Tab") return 0xff09;
  return 0xff0d;
}

function modifierMask(modifiers: readonly RemoteSurfaceKeyModifier[] = []): number {
  let value = 0;
  if (modifiers.includes("Alt")) value |= 1;
  if (modifiers.includes("Control")) value |= 2;
  if (modifiers.includes("Meta")) value |= 4;
  if (modifiers.includes("Shift")) value |= 8;
  return value;
}

async function settleAndSnapshot(surface: CdpPlaygroundSurfaceDriver): Promise<ProbeSnapshot> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  return surface.snapshot();
}

function inputPaths(telemetry: InputDispatchTrace[]): string[] {
  return [...new Set(telemetry.map((trace) => trace.path))];
}

function overlayTelemetry(telemetry: InputDispatchTrace[]): InputDispatchTrace[] {
  return telemetry.map((trace) => ({ ...trace, path: "overlay-commit" }));
}

async function executeFormOverlayOperations(
  surface: CdpPlaygroundSurfaceDriver,
  operations: readonly FormOverlayCommitOperation[],
): Promise<InputDispatchTrace[]> {
  const committedTelemetry: InputDispatchTrace[] = [];
  for (const operation of operations) {
    if (operation.type === "defer") {
      continue;
    }
    if (operation.type === "focus_field") {
      await surface.click(
        Math.round(operation.field.x + operation.field.width / 2),
        Math.round(operation.field.y + operation.field.height / 2),
        "touch",
      );
      surface.consumeInputTelemetry({ handler: "overlay-commit", text: "" });
      continue;
    }
    if (operation.type === "select_all") {
      await surface.dispatchKeyCommand("a", "KeyA", modifierMask(["Control"]));
      surface.consumeInputTelemetry({ handler: "overlay-commit", text: "" });
      continue;
    }
    if (operation.type === "clear") {
      await surface.sendKeysym({ type: "keydown", keysym: keyToKeysym("Backspace") });
      await surface.sendKeysym({ type: "keyup", keysym: keyToKeysym("Backspace") });
      committedTelemetry.push(...overlayTelemetry(surface.consumeInputTelemetry({ handler: "overlay-commit", key: "Backspace" })));
      continue;
    }
    if (operation.type === "insert_text") {
      await surface.sendText(operation.text);
      committedTelemetry.push(...overlayTelemetry(surface.consumeInputTelemetry({ handler: "overlay-commit", text: operation.text })));
      continue;
    }
    if (operation.type === "key_press" && operation.key === "Backspace" && operation.modifiers.length === 0) {
      await surface.sendKeysym({ type: "keydown", keysym: keyToKeysym("Backspace") });
      await surface.sendKeysym({ type: "keyup", keysym: keyToKeysym("Backspace") });
      committedTelemetry.push(...overlayTelemetry(surface.consumeInputTelemetry({ handler: "overlay-commit", key: operation.key })));
      continue;
    }
    if (operation.type === "submit" && operation.modifiers.length === 0) {
      await surface.sendKeysym({ type: "keydown", keysym: keyToKeysym(operation.key) });
      await surface.sendKeysym({ type: "keyup", keysym: keyToKeysym(operation.key) });
      committedTelemetry.push(...overlayTelemetry(surface.consumeInputTelemetry({ handler: "overlay-commit", key: operation.key })));
      continue;
    }
    if (operation.type === "key_press" || operation.type === "submit") {
      await surface.dispatchRawKey(operation.key, operation.code, modifierMask(operation.modifiers));
      committedTelemetry.push(...overlayTelemetry(surface.consumeInputTelemetry({ handler: "overlay-commit", key: operation.key })));
    }
  }

  return committedTelemetry;
}

async function main(): Promise<void> {
  const port = parsePort();
  const driverKind = parseDriver();
  const probeUrl = `http://127.0.0.1:${port}/probe`;
  const surface = createCdpPlaygroundSurface(probeUrl, driverKind);
  const clients = new Set<WebSocket>();
  let lastFormFieldsHash = "";
  let formFieldPoll: NodeJS.Timeout | null = null;
  const server = createServer((req, res) => {
    void serveStatic(req, res);
  });
  const wss = new WebSocketServer({ noServer: true });

  surface.onFrame((frame) => {
    broadcast(clients, {
      type: "frame",
      data: frame.data,
      metadata: frame.metadata,
      byteLength: frame.byteLength,
      receivedAt: frame.receivedAt,
    });
  });

  const sendFormFields = async (force = false) => {
    if (clients.size === 0) {
      return;
    }
    const snapshot = await surface.readFormFields();
    const hash = JSON.stringify(snapshot.fields);
    if (!(force || hash !== lastFormFieldsHash)) {
      return;
    }
    lastFormFieldsHash = hash;
    broadcast(clients, { type: "form_fields", snapshot });
  };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/surface") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    void surface.refreshScreencast()
      .then(() => surface.snapshot())
      .then((snapshot) => {
        send(ws, { type: "ready", snapshot });
        void sendFormFields(true).catch((error: unknown) => {
          send(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
        });
      });

    ws.on("message", (raw) => {
      void (async () => {
        let message: ClientMessage;
        try {
          message = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          send(ws, { type: "error", message: "Malformed WebSocket message" });
          return;
        }

        if (message.type === "hello") {
          send(ws, { type: "ready", snapshot: await surface.snapshot() });
          return;
        }
        if (message.type === "set_quality") {
          await surface.setQuality(message.quality);
          send(ws, { type: "quality", quality: Math.max(20, Math.min(100, Math.round(message.quality))) });
          return;
        }
        if (message.type === "resize") {
          await surface.resize(message.width, message.height, message.deviceScaleFactor, message.mobile);
          send(ws, { type: "snapshot", snapshot: await settleAndSnapshot(surface) });
          return;
        }
        if (message.type === "pointer_click") {
          await surface.click(message.remote.x, message.remote.y, message.pointerType ?? "touch");
          const snapshot = await settleAndSnapshot(surface);
          const observed = snapshot.lastClick
            ? {
                x: snapshot.lastClick.x,
                y: snapshot.lastClick.y,
                ...(snapshot.lastClick.target ? { target: snapshot.lastClick.target } : {}),
              }
            : null;
          const pxError = observed
            ? Math.hypot(observed.x - message.remote.x, observed.y - message.remote.y)
            : null;
          send(ws, {
            type: "pointer_result",
            intended: message.local,
            dispatched: message.remote,
            observed,
            pxError,
            snapshot,
          });
          return;
        }
        if (message.type === "click_selector") {
          const clicked = await surface.clickSelector(message.selector);
          const snapshot = await settleAndSnapshot(surface);
          const observed = snapshot.lastClick
            ? {
                x: snapshot.lastClick.x,
                y: snapshot.lastClick.y,
                ...(snapshot.lastClick.target ? { target: snapshot.lastClick.target } : {}),
              }
            : null;
          const dispatched = clicked ? { x: clicked.x, y: clicked.y } : { x: 0, y: 0 };
          const pxError = observed && clicked
            ? Math.hypot(observed.x - clicked.x, observed.y - clicked.y)
            : null;
          send(ws, {
            type: "pointer_result",
            intended: dispatched,
            dispatched,
            observed,
            pxError,
            snapshot,
          });
          return;
        }
        if (message.type === "raw_key") {
          await surface.dispatchRawKey(message.key, message.code, message.modifiers ?? 0);
          const telemetry = surface.consumeInputTelemetry({
            handler: "raw-keydown",
            key: message.key,
            text: message.key.length === 1 ? message.key : "",
          });
          const paths = inputPaths(telemetry);
          send(ws, {
            type: "input_result",
            handler: "raw-keydown",
            inputPath: paths[0] ?? "unknown",
            inputPaths: paths,
            telemetry,
            text: message.key.length === 1 ? message.key : "",
            key: message.key,
            timestamp: Date.now(),
            snapshot: await settleAndSnapshot(surface),
          });
          return;
        }
        if (message.type === "text_commit") {
          if (message.handler === "paste") {
            await surface.pasteText(message.text);
          } else {
            await surface.sendText(message.text);
          }
          const telemetry = surface.consumeInputTelemetry({ handler: message.handler, text: message.text });
          const paths = inputPaths(telemetry);
          send(ws, {
            type: "input_result",
            handler: message.handler,
            inputPath: paths[0] ?? "unknown",
            inputPaths: paths,
            telemetry,
            text: message.text,
            timestamp: Date.now(),
            snapshot: await settleAndSnapshot(surface),
          });
          return;
        }
        if (message.type === "keysym") {
          await surface.sendKeysym({ type: "keydown", keysym: keyToKeysym(message.key) });
          await surface.sendKeysym({ type: "keyup", keysym: keyToKeysym(message.key) });
          const telemetry = surface.consumeInputTelemetry({ handler: message.handler, key: message.key });
          const paths = inputPaths(telemetry);
          send(ws, {
            type: "input_result",
            handler: message.handler,
            inputPath: paths[0] ?? "unknown",
            inputPaths: paths,
            telemetry,
            text: "",
            key: message.key,
            timestamp: Date.now(),
            snapshot: await settleAndSnapshot(surface),
          });
          return;
        }
        if (message.type === "form_overlay_commit") {
          const telemetry = await executeFormOverlayOperations(surface, message.operations);
          const paths = inputPaths(telemetry);
          send(ws, {
            type: "input_result",
            handler: "synthetic",
            inputPath: paths[0] ?? "overlay-commit",
            inputPaths: paths.length > 0 ? paths : ["overlay-commit"],
            telemetry,
            text: telemetry.map((trace) => trace.text).join(""),
            timestamp: Date.now(),
            snapshot: await settleAndSnapshot(surface),
          });
          await sendFormFields(true);
          return;
        }
        if (message.type === "clear_probe") {
          send(ws, { type: "snapshot", snapshot: await surface.clearProbe() });
          return;
        }
        if (message.type === "snapshot") {
          send(ws, { type: "snapshot", snapshot: await surface.snapshot() });
        }
      })().catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        send(ws, { type: "error", message: text });
      });
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  const host = parseHost();
  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });
  await surface.start();
  formFieldPoll = setInterval(() => {
    void sendFormFields().catch((error: unknown) => {
      broadcast(clients, { type: "error", message: error instanceof Error ? error.message : String(error) });
    });
  }, 500);

  const localUrl = `http://127.0.0.1:${port}`;
  process.stdout.write(`Remote surface playground (${surface.driverKind} CDP driver): ${localUrl}\n`);
  if (host !== "127.0.0.1" && host !== "localhost") {
    for (const address of lanAddresses()) {
      process.stdout.write(`  LAN (phone): http://${address}:${port}\n`);
    }
  }
  process.stdout.write(`Probe page loaded in Chromium: ${probeUrl}\n`);

  const shutdown = async () => {
    if (formFieldPoll) {
      clearInterval(formFieldPoll);
      formFieldPoll = null;
    }
    await surface.stop();
    wss.close();
    server.close();
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
