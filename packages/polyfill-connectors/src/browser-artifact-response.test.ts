// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { BrowserContext, CDPSession, Page, Response } from "playwright";
import {
  attachBodyResponseQueue,
  isLikelyPdfResponseBody,
  sanitizeArtifactCapturePayload,
  sanitizeArtifactResponseMetadata,
} from "./browser-artifact-response.ts";

type FakeCdpSession = CDPSession & { emitCdp: (event: string, payload: unknown) => void };

function fakeCdpSession(sendImpl?: (method: string, params?: unknown) => Promise<unknown>): FakeCdpSession {
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
  fake.send = (sendImpl ?? (() => Promise.resolve({}))) as CDPSession["send"];
  fake.detach = (() => Promise.resolve()) as CDPSession["detach"];
  const session = fake as FakeCdpSession;
  session.emitCdp = (event, payload) => emitter.emit(event, payload);
  return session;
}

function fakePage(sendImpl?: (method: string, params?: unknown) => Promise<unknown>): {
  emitResponse: (response: Response) => void;
  page: Page;
  session: FakeCdpSession;
} {
  const emitter = new EventEmitter();
  const session = fakeCdpSession(sendImpl);
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
  // The discriminator this test's own title warns is otherwise unavailable:
  // both responses were rejected at the header stage, proven directly by
  // stageCdpHeaderRejected rather than inferred from candidates being empty.
  assert.equal(diag.stageCdpHeaderAccepted, 0);
  assert.equal(diag.stageCdpHeaderRejected, 2);
  assert.equal(diag.stageCdpLoadingFinished, 0);
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

// ─── Stage counters: the ambiguity `candidates: []` alone cannot resolve ────
//
// Luna's correction (2026-08-03, luna-usaa-evidence-0803.md): nonzero
// totalResponsesSeen/totalCdpResponsesSeen with zero candidates does NOT by
// itself prove `shouldInspect` rejected every response. An accepted CDP
// response can still produce zero candidates if `Network.loadingFinished`
// never fires, or if it fires but `Network.getResponseBody` rejects/never
// resolves before the caller's own timeout. These two tests exercise the
// real production queue (not a fake diagnostics object) to prove the stage
// counters actually discriminate the two cases the total counters cannot.

test("stage counters: accepted header but Network.loadingFinished never fires — header-accepted, no body-stage counters advance", async () => {
  const { page, session } = fakePage();
  const queue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await queue.ready;

  // A response whose headers pass shouldInspect (application/pdf) arrives,
  // but the request is abandoned before CDP ever emits loadingFinished —
  // e.g. the page navigated away, or the underlying stream just hung. This
  // is the "accepted response never reaches a terminal body outcome" shape
  // Luna's report identifies as indistinguishable from a header rejection
  // using only the pre-fix counters.
  session.emitCdp("Network.responseReceived", {
    requestId: "1",
    response: { headers: { "content-type": "application/pdf" }, status: 200, url: "https://example.com/statement.pdf" },
  });
  // Deliberately no Network.loadingFinished / Network.loadingFailed event.
  await new Promise((resolve) => setTimeout(resolve, 10));

  const diag = queue.diagnostics();
  assert.equal(diag.totalCdpResponsesSeen, 1);
  assert.equal(diag.candidates.length, 0, "still zero candidates, same as a header rejection would show");
  // The discriminator: header WAS accepted, but no body-stage counter ever
  // advanced. A header-rejection case (see the sibling
  // totalCdpResponsesSeen test above) would show stageCdpHeaderAccepted=0
  // and stageCdpHeaderRejected=1 instead.
  assert.equal(diag.stageCdpHeaderAccepted, 1);
  assert.equal(diag.stageCdpHeaderRejected, 0);
  assert.equal(diag.stageCdpLoadingFinished, 0);
  assert.equal(diag.stageCdpBodyFetchSucceeded, 0);
  assert.equal(diag.stageCdpBodyFetchFailed, 0);
  queue.detach();
});

test("stage counters: accepted header, loadingFinished fires, but Network.getResponseBody rejects — reaches the body stage and fails there, not a header rejection", async () => {
  const { page, session } = fakePage((method) => {
    if (method === "Network.getResponseBody") {
      return Promise.reject(new Error("No resource with given identifier found"));
    }
    return Promise.resolve({});
  });
  const queue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await queue.ready;

  session.emitCdp("Network.responseReceived", {
    requestId: "1",
    response: { headers: { "content-type": "application/pdf" }, status: 200, url: "https://example.com/statement.pdf" },
  });
  session.emitCdp("Network.loadingFinished", { requestId: "1" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const diag = queue.diagnostics();
  assert.equal(diag.totalCdpResponsesSeen, 1);
  // Unlike the no-loadingFinished case above (zero candidates, no evidence
  // at all), a getResponseBody rejection DOES already surface as a
  // body_error candidate via addDiagnostic — that part was already
  // diagnosable pre-fix. What the stage counters add is the DEFINITIVE
  // proof that this is a body-stage failure rather than a header rejection,
  // without having to infer it from candidate.reason alone.
  assert.equal(diag.candidates.length, 1);
  assert.equal(diag.candidates[0]?.reason, "body_error");
  // The discriminator: this got further than the no-loadingFinished case
  // above — it reached and failed the body-fetch stage, proven by
  // stageCdpLoadingFinished=1 alongside stageCdpBodyFetchFailed=1.
  assert.equal(diag.stageCdpHeaderAccepted, 1);
  assert.equal(diag.stageCdpLoadingFinished, 1);
  assert.equal(diag.stageCdpBodyFetchSucceeded, 0);
  assert.equal(diag.stageCdpBodyFetchFailed, 1);
  queue.detach();
});

test("stage counters: Playwright transport — accepted header, response.body() rejects", async () => {
  const { emitResponse, page } = fakePage();
  const queue = attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    shouldInspect: shouldInspectPdfHeaders,
  });
  await queue.ready;

  const failingResponse = fakeResponse({
    headers: { "content-type": "application/pdf" },
    url: "https://example.com/statement.pdf",
  });
  failingResponse.body = (() => Promise.reject(new Error("net::ERR_CONNECTION_RESET"))) as Response["body"];
  emitResponse(failingResponse);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const diag = queue.diagnostics();
  assert.equal(diag.totalResponsesSeen, 1);
  assert.equal(diag.candidates.length, 1, "a body_error still produces a bounded candidate, unlike the CDP path");
  assert.equal(diag.candidates[0]?.reason, "body_error");
  assert.equal(diag.stagePlaywrightHeaderAccepted, 1);
  assert.equal(diag.stagePlaywrightHeaderRejected, 0);
  assert.equal(diag.stagePlaywrightBodyFetchSucceeded, 0);
  assert.equal(diag.stagePlaywrightBodyFetchFailed, 1);
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

test("artifact capture sanitizer uses finite metadata and drops mutation payloads", () => {
  const payload = sanitizeArtifactCapturePayload({
    artifact: {
      body: Buffer.from("Date,Description\nPRIVATE MERCHANT,token=SECRET\n"),
      contentDisposition: 'attachment; filename="../../account-123.csv"',
      contentType: "application/x-private-token",
      method: "TRACE",
      status: 200,
      url: "https://www.usaa.com/export/account-123?token=SECRET",
    },
    download: {
      bytes: 12,
      downloadFailure: "raw failure body=SECRET",
      suggestedFilename: "../account-123.csv",
      url: "https://www.usaa.com/download/account-123?token=SECRET",
    },
    phase: "artifact",
    response_candidates: [
      {
        bodyBytes: 12,
        bodyError: "raw error body=SECRET",
        contentDisposition: "attachment; filename=account-123.csv",
        contentType: "text/csv",
        method: "GET",
        reason: "body_error",
        source: "playwright",
        status: 200,
        url: "https://www.usaa.com/export/account-123?token=SECRET",
      },
    ],
    response_summary: {
      candidate_count: 99_999_999,
      cdp_ready: true,
      total_cdp_requests_started: 99_999_999,
      total_cdp_responses_seen: 99_999_999,
      total_responses_seen: 99_999_999,
    },
  });

  assert.equal(payload.artifact?.method, null);
  assert.equal(payload.artifact?.content_type, null);
  assert.equal(payload.artifact?.filename_shape, null);
  assert.equal(payload.artifact?.path_shape, "/export/[id]");
  assert.equal(payload.download?.filename_shape, null);
  assert.equal(payload.response_candidates[0]?.method, "GET");
  assert.equal(payload.response_candidates[0]?.filename_shape, ".csv");
  assert.equal(payload.response_summary.candidate_count, 1_000_000);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(
    serialized,
    /PRIVATE MERCHANT|account-123|SECRET|https?:\/\/|raw error|bodyError|downloadFailure/
  );
});
