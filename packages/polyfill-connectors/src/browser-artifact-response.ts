// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CDPSession, Page, Response } from "playwright";

const FILENAME_PLAIN_RE = /filename="?([^";]+)"?/iu;
const FILENAME_UTF8_RE = /filename\*=UTF-8''([^;]+)/iu;
const SURROUNDING_QUOTES_RE = /^"|"$/g;
const DEFAULT_MAX_DIAGNOSTICS = 20;
const DEFAULT_ERROR_SLICE = 160;
const CSV_HEADER_HINT_RE = /(?:^|,)\s*(?:date|description|amount|transaction)\b/iu;
const SAFE_PATH_SEGMENT_RE = /^[a-z]+(?:[-_][a-z]+)*$/iu;
const SAFE_FILENAME_EXTENSION_RE = /\.([a-z0-9]{1,8})$/iu;
const CSV_FIRST_LINE_RE = /\r?\n/u;
const FILENAME_PATH_SEPARATOR_RE = /[\\/]/u;
const MAX_SAFE_PATH_SEGMENTS = 8;
const MAX_SAFE_RESPONSE_CANDIDATES = 20;
const SAFE_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const SAFE_MEDIA_TYPES = new Set([
  "application/json",
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "text/csv",
  "text/plain",
]);
const SAFE_FILENAME_EXTENSIONS = new Set(["bin", "csv", "json", "pdf", "zip"]);
const SAFE_PATH_SEGMENTS = new Set([
  "api",
  "csv",
  "document",
  "documents",
  "download",
  "export",
  "file",
  "files",
  "my",
  "pdf",
  "statement",
  "statements",
  "transaction",
  "transactions",
  "usaa",
  "v1",
  "v2",
]);

export type ArtifactClassification = "present" | "absent" | "unknown";

export interface SafeArtifactResponseMetadata {
  byte_count: number | null;
  content_disposition: "attachment" | "inline" | "other" | null;
  content_type: string | null;
  csv_header: ArtifactClassification;
  filename_shape: string | null;
  method: string | null;
  path_shape: string | null;
  pdf_magic: ArtifactClassification;
  status: number | null;
}

export interface SafeArtifactCaptureRecord {
  artifact: SafeArtifactResponseMetadata | null;
  download: SafeArtifactResponseMetadata | null;
  phase: "artifact" | "artifact_failed" | "dialog_error" | "empty";
  response_candidates: SafeArtifactResponseMetadata[];
  response_summary: {
    candidate_count: number;
    cdp_ready: boolean;
    total_cdp_requests_started: number;
    total_cdp_responses_seen: number;
    total_responses_seen: number;
  };
}

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
  csvHeader?: ArtifactClassification;
  method: string;
  pdfMagic?: ArtifactClassification;
  reason: "body_error" | "matched" | "not_expected_body";
  source: "cdp" | "playwright";
  status: number;
  url: string;
}

export interface BodyResponseDiagnostics {
  candidates: BodyResponseCandidateDiagnostic[];
  cdpError: string | null;
  cdpReady: boolean;
  // CDP `Network.requestWillBeSent` count, independent of whether any
  // response (matching or not) ever arrived. Distinguishes "a request
  // started and never got a terminal artifact" (nonzero, totalCdpResponsesSeen
  // still 0) from "nothing was even requested" (both zero) — the former is
  // consistent with a request that hung, was blocked, or whose response
  // never reached this listener; the latter means the click had no network
  // effect at all.
  totalCdpRequestsStarted: number;
  // Total network responses observed on each transport, independent of
  // `shouldInspect` filtering. Lets a caller distinguish "no traffic
  // occurred at all" (both zero) from "traffic occurred but nothing matched
  // the expected content-type/disposition filter" (nonzero, candidates
  // empty) — the two have very different root causes.
  totalCdpResponsesSeen: number;
  totalResponsesSeen: number;
}

export interface BodyResponseQueue {
  detach: () => void;
  diagnostics: () => BodyResponseDiagnostics;
  ready: Promise<void>;
  waitForNextResponse: (opts?: { timeoutMs?: number }) => Promise<CapturedBodyResponse>;
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

export function classifyCsvHeaderBody(body: Buffer | null | undefined): ArtifactClassification {
  if (!body || body.length === 0) {
    return "unknown";
  }
  const header = body.subarray(0, 4096).toString("utf8").split(CSV_FIRST_LINE_RE, 1)[0] ?? "";
  return CSV_HEADER_HINT_RE.test(header) ? "present" : "absent";
}

export function classifyPdfMagicBody(body: Buffer | null | undefined): ArtifactClassification {
  if (!body || body.length === 0) {
    return "unknown";
  }
  return body.subarray(0, 5).toString("latin1") === "%PDF-" ? "present" : "absent";
}

function artifactClassification(value: unknown): ArtifactClassification | null {
  return value === "present" || value === "absent" || value === "unknown" ? value : null;
}

function safeMethod(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const method = value.trim().toUpperCase();
  return SAFE_METHODS.has(method) ? method : null;
}

function safeStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function safeByteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : null;
}

function safeContentType(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return SAFE_MEDIA_TYPES.has(mediaType) ? mediaType : null;
}

function safeContentDisposition(value: unknown): SafeArtifactResponseMetadata["content_disposition"] {
  if (typeof value !== "string") {
    return null;
  }
  const disposition = value.trim().toLowerCase();
  if (disposition.startsWith("attachment")) {
    return "attachment";
  }
  if (disposition.startsWith("inline")) {
    return "inline";
  }
  return disposition ? "other" : null;
}

function safeFilenameShape(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (value === "." || value === ".." || FILENAME_PATH_SEPARATOR_RE.test(value)) {
    return null;
  }
  const filename = value;
  const extension = filename.match(SAFE_FILENAME_EXTENSION_RE)?.[1];
  return extension && SAFE_FILENAME_EXTENSIONS.has(extension.toLowerCase()) ? `.${extension.toLowerCase()}` : null;
}

function filenameFromContentDisposition(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const utf8 = value.match(FILENAME_UTF8_RE)?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8.replace(SURROUNDING_QUOTES_RE, ""));
    } catch {
      return utf8;
    }
  }
  return value.match(FILENAME_PLAIN_RE)?.[1] ?? null;
}

/** Retain only a path shape. Origins, query strings, hashes, and IDs vanish. */
export function redactedResponsePathShape(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const { pathname } = new URL(value);
    const sourceSegments = pathname.split("/").filter(Boolean);
    if (sourceSegments.length > MAX_SAFE_PATH_SEGMENTS) {
      return null;
    }
    const segments = sourceSegments.map((segment) => {
      const normalized = segment.toLowerCase();
      return segment.length <= 40 && SAFE_PATH_SEGMENT_RE.test(segment) && SAFE_PATH_SEGMENTS.has(normalized)
        ? normalized
        : "[id]";
    });
    return segments.length ? `/${segments.join("/")}` : "/";
  } catch {
    return null;
  }
}

/** Build response evidence without retaining body bytes, filenames, or URLs. */
export function sanitizeArtifactResponseMetadata(input: {
  readonly body?: Buffer | null;
  readonly bytes?: unknown;
  readonly contentDisposition?: unknown;
  readonly contentType?: unknown;
  readonly csvHeader?: unknown;
  readonly filename?: unknown;
  readonly method?: unknown;
  readonly pdfMagic?: unknown;
  readonly status?: unknown;
  readonly url?: unknown;
}): SafeArtifactResponseMetadata {
  const csvHeader = artifactClassification(input.csvHeader) ?? classifyCsvHeaderBody(input.body);
  const pdfMagic = artifactClassification(input.pdfMagic) ?? classifyPdfMagicBody(input.body);
  return {
    byte_count: safeByteCount(input.bytes ?? input.body?.length),
    content_disposition: safeContentDisposition(input.contentDisposition),
    content_type: safeContentType(input.contentType),
    csv_header: csvHeader,
    filename_shape: safeFilenameShape(input.filename ?? filenameFromContentDisposition(input.contentDisposition)),
    method: safeMethod(input.method),
    path_shape: redactedResponsePathShape(input.url),
    pdf_magic: pdfMagic,
    status: safeStatus(input.status),
  };
}

interface UnknownRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function boundedDiagnosticCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
}

function safeCapturePhase(value: unknown): SafeArtifactCaptureRecord["phase"] {
  return value === "artifact" || value === "artifact_failed" || value === "dialog_error" || value === "empty"
    ? value
    : "artifact_failed";
}

function safeMetadataRecord(value: unknown): SafeArtifactResponseMetadata {
  const raw = asRecord(value);
  return sanitizeArtifactResponseMetadata({
    body: Buffer.isBuffer(raw.body) ? raw.body : null,
    bytes: raw.bytes ?? raw.byte_count ?? raw.bodyBytes,
    contentDisposition: raw.contentDisposition ?? raw.content_disposition,
    contentType: raw.contentType ?? raw.content_type,
    csvHeader: raw.csvHeader ?? raw.csv_header,
    filename: raw.filename ?? raw.filename_shape ?? raw.suggestedFilename,
    method: raw.method,
    pdfMagic: raw.pdfMagic ?? raw.pdf_magic,
    status: raw.status,
    url: raw.url,
  });
}

/**
 * Canonical post-boundary sanitizer for safe capture. It accepts arbitrary
 * producer input but emits only the finite metadata contract above; bodies,
 * URLs, names, errors, and filenames are never copied into the result.
 */
export function sanitizeArtifactCapturePayload(value: unknown): SafeArtifactCaptureRecord {
  const raw = asRecord(value);
  const summary = asRecord(raw.response_summary ?? raw.responseSummary);
  let rawCandidates: unknown[] = [];
  if (Array.isArray(raw.response_candidates)) {
    rawCandidates = raw.response_candidates;
  } else if (Array.isArray(raw.responseCandidates)) {
    rawCandidates = raw.responseCandidates;
  }
  return {
    artifact: raw.artifact === null || raw.artifact === undefined ? null : safeMetadataRecord(raw.artifact),
    download: raw.download === null || raw.download === undefined ? null : safeMetadataRecord(raw.download),
    phase: safeCapturePhase(raw.phase),
    response_candidates: rawCandidates.slice(0, MAX_SAFE_RESPONSE_CANDIDATES).map(safeMetadataRecord),
    response_summary: {
      candidate_count: boundedDiagnosticCount(summary.candidate_count ?? rawCandidates.length),
      cdp_ready: summary.cdp_ready === true,
      total_cdp_requests_started: boundedDiagnosticCount(summary.total_cdp_requests_started),
      total_cdp_responses_seen: boundedDiagnosticCount(summary.total_cdp_responses_seen),
      total_responses_seen: boundedDiagnosticCount(summary.total_responses_seen),
    },
  };
}

// Exported so other diagnostics producers (e.g. the popup watcher in
// statement-pdfs.ts) can redact URLs with the same policy instead of
// leaking raw opened.url() values into diagnostics.
export function defaultRedactUrl(rawUrl: string): string {
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

interface PendingWaiter {
  reject: (err: Error) => void;
  resolveOnce: (response: CapturedBodyResponse) => void;
  timer: NodeJS.Timeout;
}

export function attachBodyResponseQueue(page: Page, options: BodyResponseQueueOptions): BodyResponseQueue {
  const pending: CapturedBodyResponse[] = [];
  const waiters: ((response: CapturedBodyResponse) => void)[] = [];
  const pendingWaiters = new Set<PendingWaiter>();
  const diagnostics: BodyResponseDiagnostics = {
    candidates: [],
    cdpError: null,
    cdpReady: false,
    totalCdpRequestsStarted: 0,
    totalCdpResponsesSeen: 0,
    totalResponsesSeen: 0,
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
        csvHeader: classifyCsvHeaderBody(body),
        method,
        pdfMagic: classifyPdfMagicBody(body),
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
      csvHeader: classifyCsvHeaderBody(body),
      method,
      pdfMagic: classifyPdfMagicBody(body),
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
    diagnostics.totalResponsesSeen += 1;
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
      });
  };

  page.on("response", onResponse);

  const onCdpRequestWillBeSent = (event: { request?: { method?: string }; requestId?: string }): void => {
    diagnostics.totalCdpRequestsStarted += 1;
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
    diagnostics.totalCdpResponsesSeen += 1;
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
        // biome-ignore lint/suspicious/noNestedPromises: the closure over detached/cdpSession/handlers below would need many params if extracted; inline is clearer here
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
      // Reject and clear any outstanding waitForNextResponse callers so their
      // setTimeout doesn't keep the event loop alive until its own deadline
      // (a losing Promise.any race arm would otherwise hold a live timer for
      // up to `timeoutMs` after the caller has already moved on).
      for (const waiter of pendingWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("body_response_queue_detached"));
      }
      pendingWaiters.clear();
      waiters.length = 0;
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
        let entry: PendingWaiter;
        const settleDone = (): void => {
          settled = true;
          const idx = waiters.indexOf(resolveOnce);
          if (idx >= 0) {
            waiters.splice(idx, 1);
          }
          pendingWaiters.delete(entry);
        };
        const timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settleDone();
          reject(new Error(`body_response_timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const resolveOnce = (response: CapturedBodyResponse): void => {
          if (settled) {
            pending.unshift(response);
            return;
          }
          settleDone();
          clearTimeout(timer);
          resolve(response);
        };
        entry = {
          reject: (err) => {
            if (settled) {
              return;
            }
            settleDone();
            reject(err);
          },
          resolveOnce,
          timer,
        };
        pendingWaiters.add(entry);
        waiters.push(resolveOnce);
      });
    },
  };
}
