// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CDPSession, Page, Response } from "playwright";

const FILENAME_PLAIN_RE = /filename="?([^";]+)"?/iu;
const FILENAME_UTF8_RE = /filename\*=UTF-8''([^;]+)/iu;
const SURROUNDING_QUOTES_RE = /^"|"$/g;
const DEFAULT_MAX_DIAGNOSTICS = 20;
const DEFAULT_ERROR_SLICE = 160;

export interface CapturedBodyResponse {
  body: Buffer;
  contentType: string;
  method: string;
  source: "cdp" | "playwright";
  status: number;
  suggestedFilename: string | null;
  url: string;
}

export interface BodyResponseCandidateDiagnostic {
  bodyBytes?: number;
  bodyError?: string;
  contentDisposition: string;
  contentType: string;
  method: string;
  reason: "body_error" | "matched" | "not_expected_body";
  source: "cdp" | "playwright";
  status: number;
  url: string;
}

export interface BodyResponseDiagnostics {
  candidates: BodyResponseCandidateDiagnostic[];
  cdpError: string | null;
  cdpReady: boolean;
}

export interface BodyResponseQueue {
  detach(): void;
  diagnostics(): BodyResponseDiagnostics;
  ready: Promise<void>;
  waitForNextResponse(opts?: { timeoutMs?: number }): Promise<CapturedBodyResponse>;
}

export interface BodyResponseQueueOptions {
  isExpectedBody: (body: Buffer, headers: Record<string, string>) => boolean;
  maxDiagnostics?: number;
  redactUrl?: (url: string) => string;
  shouldInspect: (headers: Record<string, string>, url: string) => boolean;
  truncateMessageLength?: number;
}

export async function waitForOptionalBodyResponse(
  responsePromise: Promise<CapturedBodyResponse>,
  timeoutMs: number
): Promise<CapturedBodyResponse | null> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      responsePromise.catch((): null => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function suggestedFilenameFromHeaders(headers: Record<string, string>): string | null {
  const disposition = headers["content-disposition"];
  if (!disposition) {
    return null;
  }
  const utf8 = disposition.match(FILENAME_UTF8_RE);
  if (utf8?.[1]) {
    return decodeURIComponent(utf8[1].replace(SURROUNDING_QUOTES_RE, ""));
  }
  const plain = disposition.match(FILENAME_PLAIN_RE);
  return plain?.[1] ?? null;
}

export function normalizeResponseHeaders(headers: Record<string, unknown>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return normalized;
}

export function isLikelyPdfResponseBody(body: Buffer, headers: Record<string, string>): boolean {
  if (body.length === 0) {
    return false;
  }
  const contentType = headers["content-type"]?.toLowerCase() ?? "";
  const disposition = headers["content-disposition"]?.toLowerCase() ?? "";
  if (body.subarray(0, 5).toString("latin1") === "%PDF-") {
    return true;
  }
  return contentType.includes("application/pdf") || disposition.includes(".pdf");
}

function defaultRedactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const search = url.search.replace(/\d{4,}/g, "[digits]");
    const hash = url.hash.replace(/\d{4,}/g, "[digits]");
    return `${url.origin}${url.pathname}${search}${hash}`;
  } catch {
    return rawUrl.replace(/\d{4,}/g, "[digits]");
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function attachBodyResponseQueue(page: Page, options: BodyResponseQueueOptions): BodyResponseQueue {
  const pending: CapturedBodyResponse[] = [];
  const waiters: ((response: CapturedBodyResponse) => void)[] = [];
  const diagnostics: BodyResponseDiagnostics = {
    candidates: [],
    cdpError: null,
    cdpReady: false,
  };
  const cdpMethodsByRequestId = new Map<string, string>();
  const cdpCandidatesByRequestId = new Map<
    string,
    {
      contentDisposition: string;
      contentType: string;
      headers: Record<string, string>;
      method: string;
      status: number;
      url: string;
    }
  >();
  const maxDiagnostics = options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS;
  const redactUrl = options.redactUrl ?? defaultRedactUrl;
  const truncateMessageLength = options.truncateMessageLength ?? DEFAULT_ERROR_SLICE;
  let detached = false;
  let cdpSession: CDPSession | null = null;

  const enqueue = (response: CapturedBodyResponse): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(response);
      return;
    }
    pending.push(response);
  };

  const addDiagnostic = (diagnostic: BodyResponseCandidateDiagnostic): void => {
    const next: BodyResponseCandidateDiagnostic = {
      ...diagnostic,
      url: redactUrl(diagnostic.url),
    };
    if (diagnostic.bodyError) {
      next.bodyError = truncate(diagnostic.bodyError, truncateMessageLength);
    }
    diagnostics.candidates.push(next);
    if (diagnostics.candidates.length > maxDiagnostics) {
      diagnostics.candidates.shift();
    }
  };

  const inspectBody = ({
    body,
    contentDisposition,
    contentType,
    headers,
    method,
    source,
    status,
    url,
  }: {
    body: Buffer;
    contentDisposition: string;
    contentType: string;
    headers: Record<string, string>;
    method: string;
    source: "cdp" | "playwright";
    status: number;
    url: string;
  }): void => {
    if (!options.isExpectedBody(body, headers)) {
      addDiagnostic({
        bodyBytes: body.length,
        contentDisposition,
        contentType,
        method,
        reason: "not_expected_body",
        source,
        status,
        url,
      });
      return;
    }
    addDiagnostic({
      bodyBytes: body.length,
      contentDisposition,
      contentType,
      method,
      reason: "matched",
      source,
      status,
      url,
    });
    enqueue({
      body,
      contentType,
      method,
      source,
      status,
      suggestedFilename: suggestedFilenameFromHeaders(headers),
      url,
    });
  };

  const onResponse = (response: Response): void => {
    const headers = normalizeResponseHeaders(response.headers());
    const contentType = headers["content-type"] ?? "";
    const contentDisposition = headers["content-disposition"] ?? "";
    const url = response.url();
    if (!options.shouldInspect(headers, url)) {
      return;
    }
    response
      .body()
      .then((body) => {
        if (detached) {
          return;
        }
        inspectBody({
          body,
          contentDisposition,
          contentType,
          headers,
          method: response.request().method(),
          source: "playwright",
          status: response.status(),
          url,
        });
      })
      .catch((err): undefined => {
        addDiagnostic({
          bodyError: errorMessage(err),
          contentDisposition,
          contentType,
          method: response.request().method(),
          reason: "body_error",
          source: "playwright",
          status: response.status(),
          url,
        });
        return;
      });
  };

  page.on("response", onResponse);

  const onCdpRequestWillBeSent = (event: { request?: { method?: string }; requestId?: string }): void => {
    if (event.requestId) {
      cdpMethodsByRequestId.set(event.requestId, event.request?.method ?? "");
    }
  };
  const onCdpResponseReceived = (event: {
    requestId?: string;
    response?: {
      headers?: Record<string, unknown>;
      mimeType?: string;
      status?: number;
      url?: string;
    };
  }): void => {
    if (!(event.requestId && event.response)) {
      return;
    }
    const headers = normalizeResponseHeaders(event.response.headers ?? {});
    if (!headers["content-type"] && event.response.mimeType) {
      headers["content-type"] = event.response.mimeType;
    }
    const url = event.response.url ?? "";
    if (!options.shouldInspect(headers, url)) {
      return;
    }
    cdpCandidatesByRequestId.set(event.requestId, {
      contentDisposition: headers["content-disposition"] ?? "",
      contentType: headers["content-type"] ?? "",
      headers,
      method: cdpMethodsByRequestId.get(event.requestId) ?? "",
      status: event.response.status ?? 0,
      url,
    });
  };
  const onCdpLoadingFinished = (event: { requestId?: string }): void => {
    if (!(event.requestId && cdpSession)) {
      return;
    }
    const candidate = cdpCandidatesByRequestId.get(event.requestId);
    if (!candidate) {
      return;
    }
    cdpCandidatesByRequestId.delete(event.requestId);
    cdpSession
      .send("Network.getResponseBody", { requestId: event.requestId })
      .then((payload: { base64Encoded?: boolean; body?: string }) => {
        if (detached) {
          return;
        }
        const body = payload.base64Encoded
          ? Buffer.from(payload.body ?? "", "base64")
          : Buffer.from(payload.body ?? "", "utf8");
        inspectBody({
          body,
          contentDisposition: candidate.contentDisposition,
          contentType: candidate.contentType,
          headers: candidate.headers,
          method: candidate.method,
          source: "cdp",
          status: candidate.status,
          url: candidate.url,
        });
      })
      .catch((err): undefined => {
        addDiagnostic({
          bodyError: errorMessage(err),
          contentDisposition: candidate.contentDisposition,
          contentType: candidate.contentType,
          method: candidate.method,
          reason: "body_error",
          source: "cdp",
          status: candidate.status,
          url: candidate.url,
        });
        return;
      });
  };
  const onCdpLoadingFailed = (event: { errorText?: string; requestId?: string }): void => {
    if (!event.requestId) {
      return;
    }
    const candidate = cdpCandidatesByRequestId.get(event.requestId);
    if (!candidate) {
      return;
    }
    cdpCandidatesByRequestId.delete(event.requestId);
    addDiagnostic({
      bodyError: event.errorText ?? "loading_failed",
      contentDisposition: candidate.contentDisposition,
      contentType: candidate.contentType,
      method: candidate.method,
      reason: "body_error",
      source: "cdp",
      status: candidate.status,
      url: candidate.url,
    });
  };

  const ready = page
    .context()
    .newCDPSession(page)
    .then(async (session) => {
      if (detached) {
        await session.detach().catch((): undefined => undefined);
        return;
      }
      cdpSession = session;
      session.on("Network.requestWillBeSent", onCdpRequestWillBeSent);
      session.on("Network.responseReceived", onCdpResponseReceived);
      session.on("Network.loadingFinished", onCdpLoadingFinished);
      session.on("Network.loadingFailed", onCdpLoadingFailed);
      await session.send("Network.enable");
      diagnostics.cdpReady = true;
    })
    .catch((err): undefined => {
      diagnostics.cdpError = truncate(errorMessage(err), truncateMessageLength);
      return;
    });

  return {
    ready,
    detach(): void {
      detached = true;
      page.off("response", onResponse);
      if (cdpSession) {
        cdpSession.off("Network.requestWillBeSent", onCdpRequestWillBeSent);
        cdpSession.off("Network.responseReceived", onCdpResponseReceived);
        cdpSession.off("Network.loadingFinished", onCdpLoadingFinished);
        cdpSession.off("Network.loadingFailed", onCdpLoadingFailed);
        cdpSession.detach().catch((): undefined => undefined);
        cdpSession = null;
      }
    },
    diagnostics(): BodyResponseDiagnostics {
      return {
        ...diagnostics,
        candidates: diagnostics.candidates.map((candidate) => ({ ...candidate })),
      };
    },
    waitForNextResponse({ timeoutMs = 60_000 } = {}): Promise<CapturedBodyResponse> {
      const first = pending.shift();
      if (first) {
        return Promise.resolve(first);
      }
      return new Promise<CapturedBodyResponse>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          const idx = waiters.indexOf(resolveOnce);
          if (idx >= 0) {
            waiters.splice(idx, 1);
          }
          reject(new Error(`body_response_timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const resolveOnce = (response: CapturedBodyResponse): void => {
          if (settled) {
            pending.unshift(response);
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(response);
        };
        waiters.push(resolveOnce);
      });
    },
  };
}
