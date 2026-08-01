// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Control-flow tests for `consumeDownloadOrResponse` (the actual
 * download-vs-response race statement-PDF hydration depends on) and
 * `attachPopupWatcher` (the transient-safe popup/page event capture that
 * replaced a before/after page-count snapshot). Covers the four outcomes
 * the root-cause investigation needed to discriminate between:
 *
 *   1. zero-effect click     — nothing happened at all (both arms reject,
 *                               zero response candidates, zero requests
 *                               started; matches the live failure signature
 *                               from run_6f7521cba36f476aaf58d464cfbc3f50)
 *   2. popup/new-tab download — the click opened a new page/tab that the
 *                               page-scoped download/CDP queues never see
 *   3. unmatched response     — traffic occurred but nothing matched the
 *                               PDF content-type/disposition filter
 *   4. request-start with no  — a request actually started (CDP saw
 *      terminal artifact         requestWillBeSent) but never produced a
 *                               response or download before the deadline
 *
 * These tests drive the real functions against fake DownloadQueue /
 * BodyResponseQueue / Download / Page objects so a future change to the
 * race, the fallback grace window, or the diagnostics shape has a real seam
 * to regress against.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { BrowserContext, CDPSession, Download, Locator, Page as PageType } from "playwright";
import type {
  BodyResponseDiagnostics,
  BodyResponseQueue,
  CapturedBodyResponse,
} from "../../src/browser-artifact-response.ts";
import type { DownloadQueue } from "../../src/download-queue.ts";
import { _internals } from "./statement-pdfs.ts";

const { attachPopupWatcher, consumeDownloadOrResponse, downloadViaDirectLink, DOWNLOAD_TIMEOUT_MS } = _internals;

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function fakeDiagnostics(overrides: Partial<BodyResponseDiagnostics> = {}): BodyResponseDiagnostics {
  return {
    candidates: [],
    cdpError: null,
    cdpReady: true,
    totalCdpRequestsStarted: 0,
    totalCdpResponsesSeen: 0,
    totalResponsesSeen: 0,
    ...overrides,
  };
}

function fakeResponseQueue(overrides: Partial<BodyResponseQueue> = {}): BodyResponseQueue {
  return {
    detach: () => undefined,
    diagnostics: (): BodyResponseDiagnostics => fakeDiagnostics(),
    ready: Promise.resolve(),
    waitForNextResponse: () => neverSettles<CapturedBodyResponse>(),
    ...overrides,
  };
}

function fakeDownloadQueue(overrides: Partial<DownloadQueue> = {}): DownloadQueue {
  return {
    detach: () => undefined,
    pendingCount: () => 0,
    waitForNextDownload: () => neverSettles<Download>(),
    ...overrides,
  };
}

function fakeDownload(bytes: Buffer, name = "statement.pdf"): Download {
  const fake: Partial<Download> = {};
  fake.saveAs = (async (targetPath: string) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(targetPath, bytes);
  }) as Download["saveAs"];
  fake.suggestedFilename = (() => name) as Download["suggestedFilename"];
  return fake as Download;
}

function fakeCapturedResponse(overrides: Partial<CapturedBodyResponse> = {}): CapturedBodyResponse {
  return {
    body: Buffer.from("%PDF-1.4 fake"),
    contentType: "application/pdf",
    method: "GET",
    source: "cdp",
    status: 200,
    suggestedFilename: "statement.pdf",
    url: "https://www.usaa.com/statement.pdf",
    ...overrides,
  };
}

test("consumeDownloadOrResponse returns the response body when the response arm wins the race", async () => {
  const response = fakeCapturedResponse();
  const responseQueue = fakeResponseQueue({
    waitForNextResponse: () => Promise.resolve(response),
  });
  const downloadQueue = fakeDownloadQueue();

  const result = await consumeDownloadOrResponse({ downloadQueue, responseQueue });
  assert.ok(result);
  assert.equal(result.buffer.toString(), response.body.toString());
  assert.equal(result.suggestedFilename, "statement.pdf");
});

test("consumeDownloadOrResponse returns the download buffer when the download arm wins the race", async () => {
  const bytes = Buffer.from("%PDF-1.4 downloaded");
  const downloadQueue = fakeDownloadQueue({
    waitForNextDownload: () => Promise.resolve(fakeDownload(bytes, "dl.pdf")),
  });
  const responseQueue = fakeResponseQueue();

  const result = await consumeDownloadOrResponse({ downloadQueue, responseQueue });
  assert.ok(result);
  assert.equal(result.buffer.toString(), bytes.toString());
  assert.equal(result.suggestedFilename, "dl.pdf");
});

test("consumeDownloadOrResponse falls back to a late response when the download artifact fails to persist", async () => {
  const lateResponse = fakeCapturedResponse({ suggestedFilename: "fallback.pdf" });
  // A zero-byte saveAs() with no createReadStream fallback (as our fake
  // provides) makes readPlaywrightDownloadBuffer throw, landing in the
  // download-error branch rather than the download-empty branch — both are
  // real production paths reachable when a download resolves but its
  // artifact never materializes.
  const downloadQueue = fakeDownloadQueue({
    waitForNextDownload: () => Promise.resolve(fakeDownload(Buffer.alloc(0), "empty.pdf")),
  });
  const responseQueue = fakeResponseQueue({
    // Resolves slightly after the download arm so it's only reachable via
    // the RESPONSE_FALLBACK_GRACE_MS window, not the initial race.
    waitForNextResponse: () => new Promise((resolve) => setTimeout(() => resolve(lateResponse), 20)),
  });

  const result = await consumeDownloadOrResponse({ downloadQueue, responseQueue });
  assert.ok(result);
  assert.equal(result.suggestedFilename, "fallback.pdf");
  assert.equal(typeof result.diag?.download_error, "string");
});

// ─── Outcome 1: zero-effect click ────────────────────────────────────────

test("outcome 1/4 — zero-effect click: both arms reject, zero response candidates, zero requests started", async () => {
  const diagnostics = fakeDiagnostics();
  const downloadQueue = fakeDownloadQueue({
    waitForNextDownload: () => Promise.reject(new Error(`download_timeout after ${DOWNLOAD_TIMEOUT_MS}ms`)),
  });
  const responseQueue = fakeResponseQueue({
    waitForNextResponse: () => Promise.reject(new Error(`body_response_timeout after ${DOWNLOAD_TIMEOUT_MS}ms`)),
    diagnostics: () => diagnostics,
  });

  const result = await consumeDownloadOrResponse({ downloadQueue, responseQueue });
  assert.ok(result);
  assert.equal(result.buffer.length, 0);
  assert.equal(result.diag?.response_diagnostics, diagnostics);
  // This is exactly the live signature from run_6f7521cba36f476aaf58d464cfbc3f50:
  // both arms rejected, zero response candidates, and (the discriminator a
  // response-only counter can't provide) zero requests ever started.
  assert.deepEqual(diagnostics.candidates, []);
  assert.equal(diagnostics.totalCdpRequestsStarted, 0);
  assert.equal(diagnostics.totalResponsesSeen, 0);
  assert.equal(diagnostics.totalCdpResponsesSeen, 0);
});

// ─── Outcome 2: popup/new-tab download ───────────────────────────────────

test("outcome 2/4 — popup: attachPopupWatcher attributes a transient new page even if it's gone by the time diagnostics are read", () => {
  type PageEventHandler = (opened: PageType) => void;
  let pageHandler: PageEventHandler | null = null;
  const fakeContext: Partial<BrowserContext> = {};
  fakeContext.on = ((event: string, handler: PageEventHandler) => {
    if (event === "page") {
      pageHandler = handler;
    }
    return fakeContext as BrowserContext;
  }) as BrowserContext["on"];
  fakeContext.off = (() => fakeContext as BrowserContext) as BrowserContext["off"];

  const fakePage: Partial<PageType> = {};
  fakePage.context = (() => fakeContext as BrowserContext) as PageType["context"];

  const watcher = attachPopupWatcher(fakePage as PageType);
  assert.ok(pageHandler, "expected the watcher to register a context 'page' listener");

  const popup: Partial<PageType> = {};
  popup.url = (() => "https://www.usaa.com/statements/download-popup") as PageType["url"];
  // Simulate a popup that opens, fires the "page" event, and is already
  // closed by the time the caller polls — a before/after page-count
  // snapshot would show the same count and silently miss this entirely.
  (pageHandler as PageEventHandler)(popup as PageType);

  assert.deepEqual(watcher.urls(), ["https://www.usaa.com/statements/download-popup"]);
  watcher.detach();
});

test("outcome 2/4 — popup: attachPopupWatcher never throws when context() is unreachable", () => {
  const fakePage: Partial<PageType> = {};
  fakePage.context = (() => {
    throw new Error("context unavailable");
  }) as PageType["context"];

  const watcher = attachPopupWatcher(fakePage as PageType);
  assert.deepEqual(watcher.urls(), []);
  watcher.detach();
});

test("outcome 2/4 — popup: attachPopupWatcher redacts query/hash digit runs the same way response diagnostics do", () => {
  type PageEventHandler = (opened: PageType) => void;
  let pageHandler: PageEventHandler | null = null;
  const fakeContext: Partial<BrowserContext> = {};
  fakeContext.on = ((event: string, handler: PageEventHandler) => {
    if (event === "page") {
      pageHandler = handler;
    }
    return fakeContext as BrowserContext;
  }) as BrowserContext["on"];
  fakeContext.off = (() => fakeContext as BrowserContext) as BrowserContext["off"];

  const fakePage: Partial<PageType> = {};
  fakePage.context = (() => fakeContext as BrowserContext) as PageType["context"];

  const watcher = attachPopupWatcher(fakePage as PageType);
  assert.ok(pageHandler, "expected the watcher to register a context 'page' listener");

  const popup: Partial<PageType> = {};
  // Query string carries an account-reference-shaped digit run; this must
  // not reach diagnostics verbatim.
  popup.url = (() =>
    "https://www.usaa.com/statements/download-popup?accountRef=90123456&doc=778899") as PageType["url"];
  (pageHandler as PageEventHandler)(popup as PageType);

  const [url] = watcher.urls();
  assert.ok(url, "expected a captured popup url");
  assert.ok(!/\d{4,}/.test(url), `expected digit runs redacted, got: ${url}`);
  assert.equal(url, "https://www.usaa.com/statements/download-popup?accountRef=[digits]&doc=[digits]");
  watcher.detach();
});

// ─── downloadViaDirectLink: click-error classification ───────────────────

type FakeCdpSession = CDPSession & { emitCdp: (event: string, payload: unknown) => void };

function fakeCdpSessionForDirectLink(): FakeCdpSession {
  const emitter = new EventEmitter();
  const fake: Partial<CDPSession> = {};
  fake.on = ((event: string, listener: (...args: unknown[]) => void) => {
    emitter.on(event, listener);
    return fake;
  }) as CDPSession["on"];
  fake.off = ((event: string, listener: (...args: unknown[]) => void) => {
    emitter.off(event, listener);
    return fake;
  }) as CDPSession["off"];
  fake.send = (() => Promise.resolve({})) as CDPSession["send"];
  fake.detach = (() => Promise.resolve()) as CDPSession["detach"];
  const session = fake as FakeCdpSession;
  session.emitCdp = (event, payload) => emitter.emit(event, payload);
  return session;
}

function fakePageForDirectLink(): { page: PageType } {
  const emitter = new EventEmitter();
  const session = fakeCdpSessionForDirectLink();
  const context: Partial<BrowserContext> = {};
  context.newCDPSession = (() => Promise.resolve(session)) as BrowserContext["newCDPSession"];
  context.on = (() => context as BrowserContext) as BrowserContext["on"];
  context.off = (() => context as BrowserContext) as BrowserContext["off"];

  const fake: Partial<PageType> = {};
  fake.on = ((event: string, listener: (...args: unknown[]) => void) => {
    emitter.on(event, listener);
    return fake;
  }) as PageType["on"];
  fake.off = ((event: string, listener: (...args: unknown[]) => void) => {
    emitter.off(event, listener);
    return fake;
  }) as PageType["off"];
  fake.context = (() => context as BrowserContext) as PageType["context"];
  return { page: fake as PageType };
}

function fakeRowWithFailingLink(clickError: Error): Locator {
  const link: Partial<Locator> = {};
  link.count = (() => Promise.resolve(1)) as Locator["count"];
  link.click = (() => Promise.reject(clickError)) as Locator["click"];
  const chained: Partial<Locator> = {};
  chained.first = (() => link as Locator) as Locator["first"];
  const row: Partial<Locator> = {};
  row.locator = (() => chained as Locator) as Locator["locator"];
  return row as Locator;
}

test("downloadViaDirectLink: a failing click is reported as direct_link_failed with the causal error, not swallowed into a generic timeout", async () => {
  const { page } = fakePageForDirectLink();
  const clickError = new Error("element is not attached to the DOM");
  const row = fakeRowWithFailingLink(clickError);

  const result = await downloadViaDirectLink(page, row);
  assert.ok(result);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "direct_link_failed");
    assert.equal(result.diag?.error, clickError.message);
  }
});

// ─── Outcome 3: unmatched response ───────────────────────────────────────

test("outcome 3/4 — unmatched response: traffic occurred but nothing matched the PDF filter, still zero candidates", async () => {
  const diagnostics = fakeDiagnostics({
    totalCdpRequestsStarted: 3,
    totalCdpResponsesSeen: 3,
    totalResponsesSeen: 3,
  });
  const downloadQueue = fakeDownloadQueue({
    waitForNextDownload: () => Promise.reject(new Error(`download_timeout after ${DOWNLOAD_TIMEOUT_MS}ms`)),
  });
  const responseQueue = fakeResponseQueue({
    waitForNextResponse: () => Promise.reject(new Error(`body_response_timeout after ${DOWNLOAD_TIMEOUT_MS}ms`)),
    diagnostics: () => diagnostics,
  });

  const result = await consumeDownloadOrResponse({ downloadQueue, responseQueue });
  assert.ok(result);
  assert.equal(result.buffer.length, 0);
  const responseDiag = result.diag?.response_diagnostics as BodyResponseDiagnostics;
  // Nonzero traffic, zero candidates: this is the "wrong content-type" or
  // "selector mismatch" signature, distinguishable from outcome 1 purely by
  // the total counters — the live evidence this instrumentation exists to
  // surface next run.
  assert.equal(responseDiag.totalResponsesSeen, 3);
  assert.equal(responseDiag.candidates.length, 0);
});

// ─── Outcome 4: request-start with no terminal artifact ─────────────────

test("outcome 4/4 — request-start/no-terminal-artifact: a request began but never produced a response or download before timeout", async () => {
  const diagnostics = fakeDiagnostics({
    totalCdpRequestsStarted: 1,
    totalCdpResponsesSeen: 0,
    totalResponsesSeen: 0,
  });
  const downloadQueue = fakeDownloadQueue({
    waitForNextDownload: () => Promise.reject(new Error(`download_timeout after ${DOWNLOAD_TIMEOUT_MS}ms`)),
  });
  const responseQueue = fakeResponseQueue({
    waitForNextResponse: () => Promise.reject(new Error(`body_response_timeout after ${DOWNLOAD_TIMEOUT_MS}ms`)),
    diagnostics: () => diagnostics,
  });

  const result = await consumeDownloadOrResponse({ downloadQueue, responseQueue });
  assert.ok(result);
  assert.equal(result.buffer.length, 0);
  const responseDiag = result.diag?.response_diagnostics as BodyResponseDiagnostics;
  // The discriminator: a request started (nonzero) but neither transport
  // ever saw a response (both zero) — a hung/blocked/never-delivered
  // request, not a click with zero network effect (outcome 1, where this
  // counter would also read 0).
  assert.equal(responseDiag.totalCdpRequestsStarted, 1);
  assert.equal(responseDiag.totalCdpResponsesSeen, 0);
  assert.equal(responseDiag.totalResponsesSeen, 0);
});
