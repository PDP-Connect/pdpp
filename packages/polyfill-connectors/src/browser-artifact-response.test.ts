// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { BrowserContext, CDPSession, Page, Response } from "playwright";
import {
  attachBodyResponseQueue,
  isLikelyPdfResponseBody,
  sanitizeArtifactResponseMetadata,
} from "./browser-artifact-response.ts";

type FakeCdpSession = CDPSession & { emitCdp: (event: string, payload: unknown) => void };

function fakeCdpSession(): FakeCdpSession {
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

function fakePage(): { emitResponse: (response: Response) => void; page: Page; session: FakeCdpSession } {
  const emitter = new EventEmitter();
  const session = fakeCdpSession();
  const fake: Partial<Page> = {};
  fake.on = ((event: string, listener: (...args: unknown[]) => void) => {
    emitter.on(event, listener);
    return fake;
  }) as Page["on"];
  fake.off = ((event: string, listener: (...args: unknown[]) => void) => {
    emitter.off(event, listener);
    return fake;
  }) as Page["off"];
  fake.context = (() => {
    const context: Partial<BrowserContext> = {};
    context.newCDPSession = (() => Promise.resolve(session)) as BrowserContext["newCDPSession"];
    return context as BrowserContext;
  }) as Page["context"];
  return { emitResponse: (response) => emitter.emit("response", response), page: fake as Page, session };
}

function fakeResponse(overrides: { headers?: Record<string, string>; status?: number; url?: string } = {}): Response {
  const fake: Partial<Response> = {};
  fake.body = (() => Promise.resolve(Buffer.from("not a pdf"))) as Response["body"];
  fake.headers = (() => overrides.headers ?? {}) as Response["headers"];
  fake.request = (() => ({ method: () => "GET" })) as Response["request"];
  fake.status = (() => overrides.status ?? 200) as Response["status"];
  fake.url = (() => overrides.url ?? "https://example.com/x") as Response["url"];
  return fake as Response;
}

function shouldInspectPdfHeaders(headers: Record<string, string>): boolean {
  const contentType = headers["content-type"]?.toLowerCase() ?? "";
  const disposition = headers["content-disposition"]?.toLowerCase() ?? "";
  return contentType.includes("pdf") || disposition.includes(".pdf") || disposition.includes("attachment");
}

test("totalResponsesSeen counts every response even when none match the expected-body filter", async () => {
  const { emitResponse, page } = fakePage();
  const queue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await queue.ready;

  emitResponse(fakeResponse({ headers: { "content-type": "text/html" } }));
  emitResponse(fakeResponse({ headers: { "content-type": "application/json" } }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const diag = queue.diagnostics();
  assert.equal(diag.totalResponsesSeen, 2);
  assert.equal(diag.candidates.length, 0);
  queue.detach();
});

test("totalCdpResponsesSeen counts CDP network events independent of shouldInspect", async () => {
  const { page, session } = fakePage();
  const queue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await queue.ready;

  session.emitCdp("Network.responseReceived", {
    requestId: "1",
    response: { headers: { "content-type": "text/html" }, status: 200, url: "https://example.com/a" },
  });
  session.emitCdp("Network.responseReceived", {
    requestId: "2",
    response: { headers: { "content-type": "text/css" }, status: 200, url: "https://example.com/b" },
  });

  const diag = queue.diagnostics();
  assert.equal(diag.totalCdpResponsesSeen, 2);
  assert.equal(diag.candidates.length, 0);
  assert.equal(diag.cdpReady, true);
  queue.detach();
});

test("totalCdpRequestsStarted counts requestWillBeSent independent of whether a response ever arrives", async () => {
  const { page, session } = fakePage();
  const queue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await queue.ready;

  // Two requests start; only one ever gets a responseReceived event. This is
  // the "request-start/no-terminal-artifact" signature: a click that fired a
  // real network request which never resolved (hung, blocked, or otherwise
  // never reached this listener) — distinguishable from a zero-effect click
  // (totalCdpRequestsStarted would stay 0) purely via this counter.
  session.emitCdp("Network.requestWillBeSent", { request: { method: "GET" }, requestId: "1" });
  session.emitCdp("Network.requestWillBeSent", { request: { method: "GET" }, requestId: "2" });
  session.emitCdp("Network.responseReceived", {
    requestId: "1",
    response: { headers: { "content-type": "text/html" }, status: 200, url: "https://example.com/a" },
  });

  const diag = queue.diagnostics();
  assert.equal(diag.totalCdpRequestsStarted, 2);
  assert.equal(diag.totalCdpResponsesSeen, 1);
  queue.detach();
});

test("totalCdpRequestsStarted stays 0 when the click had no network effect at all", async () => {
  const { page } = fakePage();
  const queue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await queue.ready;

  const diag = queue.diagnostics();
  assert.equal(diag.totalCdpRequestsStarted, 0);
  assert.equal(diag.totalCdpResponsesSeen, 0);
  assert.equal(diag.totalResponsesSeen, 0);
  queue.detach();
});

test("a matching response is still captured as a candidate alongside the total counter", async () => {
  const { emitResponse, page } = fakePage();
  const queue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await queue.ready;

  emitResponse(fakeResponse({ headers: { "content-type": "text/html" } }));
  emitResponse(
    fakeResponse({
      headers: { "content-type": "application/pdf" },
      url: "https://example.com/statement.pdf",
    })
  );
  const response = await queue.waitForNextResponse({ timeoutMs: 1000 });
  assert.equal(response.url, "https://example.com/statement.pdf");

  const diag = queue.diagnostics();
  assert.equal(diag.totalResponsesSeen, 2);
  assert.equal(diag.candidates.length, 1);
  assert.equal(diag.candidates[0]?.reason, "matched");
  queue.detach();
});

test("detach() immediately rejects an outstanding waitForNextResponse instead of leaving its timer to fire later", async () => {
  const { page } = fakePage();
  const queue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await queue.ready;

  const waitPromise = queue.waitForNextResponse({ timeoutMs: 60_000 });
  waitPromise.catch((): undefined => undefined);

  const start = Date.now();
  queue.detach();
  await assert.rejects(waitPromise, /body_response_queue_detached/);
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 1000, `expected immediate rejection on detach, took ${elapsedMs}ms`);
});

test("waitForNextResponse rejects after timeoutMs when nothing matches", async () => {
  const { page } = fakePage();
  const queue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await queue.ready;
  await assert.rejects(queue.waitForNextResponse({ timeoutMs: 20 }), /body_response_timeout/);
  queue.detach();
});

test("a fresh attach after detach starts its counters at zero — prior attempt's traffic does not leak forward", async () => {
  // Each row-download attempt calls attachPdfResponseQueue(page) fresh and
  // detach()es in a finally, so this models what a real second attempt on
  // the same page sees. The counters here are per-attempt (queue-lifetime,
  // where "queue lifetime" == "one attempt"), not accumulated across the
  // whole hydration run — this test is the isolation guarantee that claim
  // depends on.
  const { emitResponse, page, session: firstSession } = fakePage();
  const firstQueue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await firstQueue.ready;

  firstSession.emitCdp("Network.requestWillBeSent", { request: { method: "GET" }, requestId: "prior-1" });
  emitResponse(fakeResponse({ headers: { "content-type": "text/html" } }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const firstDiag = firstQueue.diagnostics();
  assert.equal(firstDiag.totalCdpRequestsStarted, 1);
  assert.equal(firstDiag.totalResponsesSeen, 1);
  firstQueue.detach();

  // Second attempt: brand new attach on the same underlying page object,
  // same pattern statement-pdfs.ts uses between rows. Its own CDP session
  // (from a fresh newCDPSession() call) starts from zero regardless of what
  // the first attempt observed.
  const secondQueue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await secondQueue.ready;

  const secondDiag = secondQueue.diagnostics();
  assert.equal(secondDiag.totalCdpRequestsStarted, 0);
  assert.equal(secondDiag.totalCdpResponsesSeen, 0);
  assert.equal(secondDiag.totalResponsesSeen, 0);
  assert.deepEqual(secondDiag.candidates, []);
  secondQueue.detach();
});

test("artifact metadata preserves response shape while dropping URLs, identifiers, filenames, and bytes", () => {
  const metadata = sanitizeArtifactResponseMetadata({
    body: Buffer.from("Date,Description,Amount\n2026-01-01,PRIVATE MERCHANT,10.00\n"),
    contentDisposition: 'attachment; filename="statement-account-123.csv"',
    contentType: "text/csv; charset=utf-8",
    method: "post",
    status: 200,
    url: "https://www.usaa.com/export/account-123?accountId=SECRET&token=COOKIE",
  });

  assert.deepEqual(metadata, {
    byte_count: 58,
    content_disposition: "attachment",
    content_type: "text/csv",
    csv_header: "present",
    filename_shape: ".csv",
    method: "POST",
    path_shape: "/export/[id]",
    pdf_magic: "absent",
    status: 200,
  });
  const serialized = JSON.stringify(metadata);
  assert.doesNotMatch(serialized, /PRIVATE MERCHANT|account-123|SECRET|COOKIE|https?:\/\//);
});
