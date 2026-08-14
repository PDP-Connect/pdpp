// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production network adapter for bounded declaration retrieval.
 *
 * `retrieval.ts` owns URL, DNS, address-policy, redirect, time, and byte
 * bounds. This adapter makes its validated-address fetch contract real: every
 * request receives a fresh undici dispatcher which dials only those literal
 * addresses. The URL hostname remains intact, so HTTP authority, TLS SNI, and
 * certificate hostname verification still authenticate the declaration URL.
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { fetch as undiciFetch } from "undici";
import { createPinnedDispatcher, MAX_VALIDATED_ADDRESSES } from "../ssrf-guard.ts";
import {
  type DeclarationFetchRequest,
  type DeclarationResponse,
  DeclarationResponseTooLargeError,
  type DeclarationRetrievalDependencies,
} from "./retrieval.ts";

type LiveFetchResponse = Pick<Awaited<ReturnType<typeof undiciFetch>>, "body" | "headers" | "status">;
interface PinnedDispatcher {
  readonly close: () => Promise<void>;
}

interface LiveFetchInit {
  readonly credentials: "omit";
  readonly dispatcher: PinnedDispatcher;
  readonly method: "GET";
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}
type LiveFetch = (input: string, init: LiveFetchInit) => Promise<LiveFetchResponse>;

type PinnedDispatcherFactory = (validatedAddresses: readonly string[]) => PinnedDispatcher;

export type DeclarationDnsLookup = (
  hostname: string,
  options: { all: true }
) => Promise<ReadonlyArray<{ readonly address: string }>>;

export interface LiveDeclarationRetrievalOptions
  extends Pick<DeclarationRetrievalDependencies, "allowsUrl" | "validateAddress" | "validateDeclaration"> {
  /** Defaults to `node:dns` with `{ all: true }`; address policy stays injected. */
  readonly dnsLookupImpl?: DeclarationDnsLookup;
  /** Test seam for the concrete HTTP client; production defaults to undici. */
  readonly fetchImpl?: LiveFetch;
  /** Test seam for the shared DNS-rebinding-safe undici dispatcher. */
  readonly pinnedDispatcherFactory?: PinnedDispatcherFactory;
}

function defaultDnsLookup(
  hostname: string,
  options: { all: true }
): Promise<ReadonlyArray<{ readonly address: string }>> {
  return dnsLookup(hostname, options);
}

function headersToRecord(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries(headers.entries());
}

function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function closeDispatcher(dispatcher: PinnedDispatcher): void {
  // Closing releases idle resources after EOF/cancellation. Its result must
  // not become a retrieval outcome: the response stream is already complete
  // (or has failed) by the time this runs.
  dispatcher.close().catch(() => {
    // Best effort teardown only.
  });
}

function closeDispatcherWhenBodySettles(
  body: ReadableStream<Uint8Array>,
  dispatcher: PinnedDispatcher,
  maxBytes: number
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let settled = false;
  let totalBytes = 0;
  const finish = () => {
    if (!settled) {
      settled = true;
      reader.releaseLock();
      closeDispatcher(dispatcher);
    }
  };

  return new ReadableStream({
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          finish();
          return;
        }
        totalBytes += next.value.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel("declaration response exceeds configured bounds");
          } catch {
            // The byte bound wins if a peer-side failure races cancellation.
          }
          finish();
          controller.error(new DeclarationResponseTooLargeError());
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
  });
}

/**
 * Creates the concrete fetch operation used by declaration retrieval.
 *
 * It refuses an empty or oversized connector set even though the retriever
 * already rejects those answers. This prevents direct misuse of the exported
 * transport seam from silently truncating `createPinnedDispatcher`'s bounded
 * fallback list. It deliberately does not apply the SSRF guard's global
 * unicast policy: callers inject their own `validateAddress` policy before
 * this function is called, including any sanctioned local-development rule.
 */
export function createPinnedDeclarationFetch({
  fetchImpl = (input, init) => undiciFetch(input, init as Parameters<typeof undiciFetch>[1]),
  pinnedDispatcherFactory = createPinnedDispatcher,
}: Pick<LiveDeclarationRetrievalOptions, "fetchImpl" | "pinnedDispatcherFactory"> = {}): (
  request: DeclarationFetchRequest
) => Promise<DeclarationResponse> {
  return async (request) => {
    if (request.validatedAddresses.length === 0 || request.validatedAddresses.length > MAX_VALIDATED_ADDRESSES) {
      throw new Error("declaration request requires a non-empty, bounded validated address set");
    }
    const dispatcher = pinnedDispatcherFactory(request.validatedAddresses);
    let response: LiveFetchResponse;
    try {
      response = await fetchImpl(request.url, {
        credentials: request.credentials,
        dispatcher,
        method: "GET",
        redirect: request.redirect,
        signal: request.signal,
      });
    } catch (error) {
      closeDispatcher(dispatcher);
      throw error;
    }
    if (!response.body) {
      closeDispatcher(dispatcher);
      return { body: emptyBody(), headers: headersToRecord(response.headers), status: response.status };
    }
    return {
      body: closeDispatcherWhenBodySettles(response.body, dispatcher, request.maxBytes),
      headers: headersToRecord(response.headers),
      status: response.status,
    };
  };
}

/**
 * Composes the live DNS and pinned-socket transport with caller-owned policy
 * and Source-contract validation. The retrieval core invokes `resolveDns` on
 * every redirect hop, then passes only that hop's accepted addresses to the
 * concrete fetch above.
 */
export function createLiveDeclarationRetrievalDependencies({
  allowsUrl,
  dnsLookupImpl = defaultDnsLookup,
  fetchImpl,
  pinnedDispatcherFactory,
  validateAddress,
  validateDeclaration,
}: LiveDeclarationRetrievalOptions): DeclarationRetrievalDependencies {
  return {
    ...(allowsUrl ? { allowsUrl } : {}),
    fetch: createPinnedDeclarationFetch({
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(pinnedDispatcherFactory ? { pinnedDispatcherFactory } : {}),
    }),
    resolveDns: async (hostname) => (await dnsLookupImpl(hostname, { all: true })).map(({ address }) => address),
    validateAddress,
    validateDeclaration,
  };
}
