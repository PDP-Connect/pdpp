// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-free, bounded declaration retrieval.
 *
 * This module deliberately does not import a network client, DNS resolver, or
 * SourceDeclaration schema. The caller injects each effect and the existing
 * Source contract validator. That leaves one small policy boundary to test:
 * each hop resolves and validates its own addresses before a credential-free
 * request is allowed to connect to one of them.
 */

export interface RetrievedDeclaration {
  readonly declaration: {
    readonly declaration_version: string;
    readonly source: { readonly id: string; readonly kind: string };
    readonly [member: string]: unknown;
  };
  readonly finalUrl: string;
}

export type DeclarationRetrievalFailure =
  | "address_rejected"
  | "body_too_large"
  | "declaration_invalid"
  | "http_error"
  | "invalid_declaration_url"
  | "invalid_redirect"
  | "redirect_limit"
  | "source_mismatch"
  | "timeout";

export type DeclarationRetrievalResult =
  | { readonly ok: true; readonly value: RetrievedDeclaration }
  | { readonly ok: false; readonly reason: DeclarationRetrievalFailure };

/** Raised by a live HTTP adapter that stops a response before it exceeds its byte contract. */
export class DeclarationResponseTooLargeError extends Error {
  constructor() {
    super("declaration response exceeds configured bounds");
    this.name = "DeclarationResponseTooLargeError";
  }
}

export interface DeclarationResponse {
  /** A fresh response stream. The retriever reads and cancels it at `maxBytes`. */
  readonly body: ReadableStream<Uint8Array>;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly status: number;
}

export interface DeclarationFetchRequest {
  /** Retrieval never forwards cookies, bearer tokens, or other ambient credentials. */
  readonly credentials: "omit";
  /** Whole-response byte limit which the HTTP adapter must also enforce while streaming. */
  readonly maxBytes: number;
  /** Never let the injected HTTP client follow an unvalidated redirect itself. */
  readonly redirect: "manual";
  readonly signal: AbortSignal;
  /** The URL whose authority TLS must authenticate. */
  readonly url: string;
  /** DNS answers just resolved and accepted for this exact connection attempt. */
  readonly validatedAddresses: readonly string[];
}

export interface DeclarationRetrievalDependencies {
  /**
   * The initial pointer and every target must be explicitly accepted. The
   * default policy below permits only the exact accepted pointer; redirects
   * are therefore denied unless a caller supplies a narrower local policy.
   */
  readonly allowsUrl?: (input: {
    acceptedPointer: string;
    fromUrl: string | null;
    targetUrl: string;
  }) => boolean | Promise<boolean>;
  readonly fetch: (request: DeclarationFetchRequest) => Promise<DeclarationResponse>;
  readonly resolveDns: (hostname: string) => Promise<readonly string[]>;
  readonly validateAddress: (input: { address: string; hostname: string; url: string }) => boolean | Promise<boolean>;
  /**
   * Validate against the Source Declaration contract already owned by
   * `@pdpp/reference-contract`. It must not retrieve remote schemas.
   */
  readonly validateDeclaration: (
    value: unknown
  ) => { readonly ok: true; readonly declaration: RetrievedDeclaration["declaration"] } | { readonly ok: false };
}

export interface DeclarationRetrievalPolicy {
  readonly maxAddresses: number;
  readonly maxBytes: number;
  readonly maxRedirects: number;
  readonly timeoutMs: number;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_SUPPORTED_ADDRESSES = 16;
const MAX_SUPPORTED_REDIRECTS = 16;

type HopValidationResult =
  | { readonly ok: true; readonly validatedAddresses: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: "address_rejected" | "invalid_declaration_url" | "invalid_redirect" | "timeout";
    };

const DEADLINE_EXCEEDED = new Error("Declaration retrieval deadline exceeded.");

function hasSafeHttpsAuthority(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hash === "" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function readHeader(headers: DeclarationResponse["headers"], name: string): string | null {
  if (!headers) {
    return null;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === "string") {
      return value;
    }
  }
  return null;
}

function parseJson(body: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
}

async function discardResponseBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
  try {
    await beforeDeadline(signal, body.cancel("declaration response is not accepted"));
  } catch {
    // A peer may already have failed the stream. The response is discarded in
    // either case; its cancellation failure must not escape the fail-closed API.
  }
}

function discardLateResponseBody(body: ReadableStream<Uint8Array>): void {
  try {
    body.cancel("declaration response arrived after the retrieval deadline").catch(() => {
      // The late response is no longer observable by the caller. Best-effort
      // cancellation still releases a live adapter's pinned dispatcher.
    });
  } catch {
    // A non-conforming injected stream must not turn a timed-out retrieval
    // into an unhandled exception.
  }
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: each read depends on the prior stream chunk; byte and time bounds cap retained work.
      const next = await beforeDeadline(signal, reader.read());
      if (next.done) {
        return joinChunks(chunks, total);
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        try {
          await beforeDeadline(signal, reader.cancel("declaration response exceeds configured bounds"));
        } catch {
          // The configured response bound still wins when cancellation races a
          // peer-side failure; callers receive body_too_large rather than a throw.
        }
        return null;
      }
      if (next.value.byteLength !== 0) {
        chunks.push(next.value);
      }
    }
  } catch (error) {
    try {
      await beforeDeadline(signal, reader.cancel("declaration response read failed"));
    } catch {
      // The typed retrieval failure still wins when peer cancellation races a
      // read failure or ignores the abort signal.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function joinChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function boundedTimeout(timeoutMs: number): AbortSignal | null {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return AbortSignal.timeout(timeoutMs);
}

function defaultAllowsUrl(acceptedPointer: string, targetUrl: string): boolean {
  return acceptedPointer === targetUrl;
}

function beforeDeadline<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(DEADLINE_EXCEEDED);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error: unknown) => {
        finish();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

async function validateHop(
  currentUrl: string,
  previousUrl: string | null,
  input: { readonly acceptedPointer: string },
  policy: Pick<DeclarationRetrievalPolicy, "maxAddresses">,
  dependencies: DeclarationRetrievalDependencies,
  signal: AbortSignal
): Promise<HopValidationResult> {
  if (!hasSafeHttpsAuthority(currentUrl)) {
    return { ok: false, reason: "invalid_declaration_url" };
  }
  let allowed: boolean;
  try {
    allowed = dependencies.allowsUrl
      ? await beforeDeadline(
          signal,
          Promise.resolve(
            dependencies.allowsUrl({
              acceptedPointer: input.acceptedPointer,
              fromUrl: previousUrl,
              targetUrl: currentUrl,
            })
          )
        )
      : defaultAllowsUrl(input.acceptedPointer, currentUrl);
  } catch (error) {
    return { ok: false, reason: error === DEADLINE_EXCEEDED ? "timeout" : "invalid_redirect" };
  }
  if (!allowed) {
    return { ok: false, reason: previousUrl ? "invalid_redirect" : "invalid_declaration_url" };
  }
  const { hostname } = new URL(currentUrl);
  try {
    const resolved = await beforeDeadline(signal, dependencies.resolveDns(hostname));
    if (resolved.length === 0 || resolved.length > policy.maxAddresses) {
      return { ok: false, reason: "address_rejected" };
    }
    const accepted = await beforeDeadline(
      signal,
      Promise.all(
        resolved.map(async (address) => ({
          accepted: await dependencies.validateAddress({ address, hostname, url: currentUrl }),
          address,
        }))
      )
    );
    if (accepted.some(({ accepted: acceptedAddress }) => !acceptedAddress)) {
      return { ok: false, reason: "address_rejected" };
    }
    return { ok: true, validatedAddresses: accepted.map(({ address }) => address) };
  } catch (error) {
    return { ok: false, reason: error === DEADLINE_EXCEEDED ? "timeout" : "address_rejected" };
  }
}

function redirectTarget(response: DeclarationResponse, currentUrl: string): string | null {
  const location = readHeader(response.headers, "location");
  if (!location) {
    return null;
  }
  try {
    const targetUrl = new URL(location, currentUrl).toString();
    return hasSafeHttpsAuthority(targetUrl) ? targetUrl : null;
  } catch {
    return null;
  }
}

async function parseAcceptedResponse(
  response: DeclarationResponse,
  currentUrl: string,
  expectedSourceId: string,
  maxBytes: number,
  dependencies: DeclarationRetrievalDependencies,
  signal: AbortSignal
): Promise<DeclarationRetrievalResult> {
  let body: Uint8Array | null;
  try {
    body = await readBoundedBody(response.body, maxBytes, signal);
  } catch (error) {
    if (error instanceof DeclarationResponseTooLargeError) {
      return { ok: false, reason: "body_too_large" };
    }
    if (error === DEADLINE_EXCEEDED) {
      return { ok: false, reason: "timeout" };
    }
    return {
      ok: false,
      reason: "http_error",
    };
  }
  if (body === null) {
    return { ok: false, reason: "body_too_large" };
  }
  const parsed = parseJson(body);
  let validated: ReturnType<DeclarationRetrievalDependencies["validateDeclaration"]>;
  try {
    validated = parsed === null ? { ok: false } : dependencies.validateDeclaration(parsed);
  } catch {
    return { ok: false, reason: "declaration_invalid" };
  }
  if (!validated.ok) {
    return { ok: false, reason: "declaration_invalid" };
  }
  if (validated.declaration.source.id !== expectedSourceId) {
    return { ok: false, reason: "source_mismatch" };
  }
  return { ok: true, value: { declaration: validated.declaration, finalUrl: currentUrl } };
}

async function retrieveHop(
  currentUrl: string,
  previousUrl: string | null,
  redirects: number,
  input: { readonly acceptedPointer: string; readonly expectedSourceId: string },
  policy: DeclarationRetrievalPolicy,
  dependencies: DeclarationRetrievalDependencies,
  signal: AbortSignal
): Promise<DeclarationRetrievalResult> {
  if (signal.aborted) {
    return { ok: false, reason: "timeout" };
  }
  const hop = await validateHop(currentUrl, previousUrl, input, policy, dependencies, signal);
  if (!hop.ok) {
    return hop;
  }
  let fetchOperation: Promise<DeclarationResponse> | null = null;
  let response: DeclarationResponse;
  try {
    fetchOperation = dependencies.fetch({
      credentials: "omit",
      maxBytes: policy.maxBytes,
      redirect: "manual",
      signal,
      url: currentUrl,
      validatedAddresses: hop.validatedAddresses,
    });
    response = await beforeDeadline(signal, fetchOperation);
  } catch (error) {
    if (error === DEADLINE_EXCEEDED && fetchOperation) {
      fetchOperation.then(
        (lateResponse) => discardLateResponseBody(lateResponse.body),
        () => {
          // The timeout result already owns this failure path.
        }
      );
    }
    return { ok: false, reason: error === DEADLINE_EXCEEDED ? "timeout" : "http_error" };
  }
  if (signal.aborted) {
    await discardResponseBody(response.body, signal);
    return { ok: false, reason: "timeout" };
  }
  if (REDIRECT_STATUS.has(response.status)) {
    await discardResponseBody(response.body, signal);
    if (redirects >= policy.maxRedirects) {
      return { ok: false, reason: "redirect_limit" };
    }
    const targetUrl = redirectTarget(response, currentUrl);
    if (!targetUrl) {
      return { ok: false, reason: "invalid_redirect" };
    }
    return retrieveHop(targetUrl, currentUrl, redirects + 1, input, policy, dependencies, signal);
  }
  if (response.status < 200 || response.status >= 300) {
    await discardResponseBody(response.body, signal);
    return { ok: false, reason: "http_error" };
  }
  return parseAcceptedResponse(response, currentUrl, input.expectedSourceId, policy.maxBytes, dependencies, signal);
}

/**
 * Fetch and validate one declaration without using ambient process networking
 * or source-schema state. A failure never returns partially parsed content.
 */
export function retrieveSourceDeclaration(
  input: { readonly acceptedPointer: string; readonly expectedSourceId: string },
  policy: DeclarationRetrievalPolicy,
  dependencies: DeclarationRetrievalDependencies
): Promise<DeclarationRetrievalResult> {
  if (
    !(hasSafeHttpsAuthority(input.acceptedPointer) && Number.isSafeInteger(policy.maxBytes)) ||
    policy.maxBytes <= 0 ||
    !Number.isSafeInteger(policy.maxRedirects) ||
    policy.maxRedirects < 0 ||
    policy.maxRedirects > MAX_SUPPORTED_REDIRECTS ||
    !Number.isSafeInteger(policy.maxAddresses) ||
    policy.maxAddresses < 1 ||
    policy.maxAddresses > MAX_SUPPORTED_ADDRESSES
  ) {
    return Promise.resolve({ ok: false, reason: "invalid_declaration_url" } as const);
  }

  const signal = boundedTimeout(policy.timeoutMs);
  if (!signal) {
    return Promise.resolve({ ok: false, reason: "timeout" } as const);
  }
  return retrieveHop(input.acceptedPointer, null, 0, input, policy, dependencies, signal);
}
