// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Records a connector run's HTTP traffic into `ScenarioInteraction[]` for a
 * single scenario run. `createRecordingFetch` wraps an underlying `fetch`
 * (real or, in this spike, an in-process synthetic provider) so a connector
 * calling the wrapped function is unaware it's being recorded.
 *
 * Redaction happens BEFORE anything is handed to the sink — never after.
 * There is no "redact on read" path: a value this module doesn't persist
 * never exists in the sink's storage to begin with.
 *
 * A query param whose name matches the credential pattern is either:
 *   - a genuine client-supplied credential (its value never appeared in an
 *     EARLIER recorded response body in this run) — redacted and listed as a
 *     normalizer, as before; or
 *   - provider-issued (pagination cursors like `next_token`, continuation
 *     tokens — its value DID appear in an earlier response body) — recorded
 *     as a `ScenarioBinding` ({param, source_seq, json_path}) instead of a
 *     raw query value. The param is excluded from the stored query entirely
 *     (neither the raw value nor a normalizer entry) — replay resolves the
 *     expected value from the response it actually served for `source_seq`
 *     (see replay.ts's binding resolution), so the value is proven without
 *     ever being persisted raw.
 *
 * FIX 4 (recorder unification, re-review): this module previously kept a
 * provider-issued credential-named value RAW in the stored query (the "kept,
 * not redacted" heuristic) — diverging from
 * `src/scenario/subprocess-fetch-preloads.ts`'s RECORD preload, which
 * already produces bindings. Provenance is not non-secrecy: a value being
 * provider-issued only proves the RECORDER doesn't need to protect it from
 * itself (the recorder already saw it in a response) — it says nothing about
 * whether the value is safe to leave sitting in a committed/shared scenario
 * file's request query, which is exactly the class of exposure the binding
 * model (never persisting the value at all, only its provenance) closes.
 * This module now matches the preload's binding model exactly, so the
 * in-process recorder (used by unit tests and connector spikes) and the
 * subprocess recorder (used by `bin/scenario-record.ts`) can never diverge
 * on what "safe to persist" means.
 */

import { createHash } from "node:crypto";
import type { ScenarioBinding, ScenarioInteraction, ScenarioNormalizer } from "./format.ts";

const CREDENTIAL_QUERY_PARAM_RE = /token|key|secret|signature|auth/i;
const MAX_STORED_BODY_BYTES = 2 * 1024 * 1024;
/** Minimum string length to be considered a candidate provider-issued value.
 *  Short strings (status codes, single words) are common and would cause
 *  false "provider-issued" matches for genuine short credentials. */
const MIN_PROVIDER_VALUE_LENGTH = 8;
/** Caps the per-run provider-issued-value set so a pathologically large
 *  response body can't grow this set unboundedly across a long run. */
const MAX_PROVIDER_VALUES = 10_000;

/** Sorts [name, value] query pairs by name. */
function compareQueryPair(pairA: [string, string], pairB: [string, string]): number {
  return pairA[0].localeCompare(pairB[0]);
}

export interface RecordSink {
  /** Called once, after the run's interactions are all recorded (or a
   *  storage error occurred). Sets `capture.complete` accordingly. */
  finalize: () => { complete: boolean };
  /** Persist one interaction. May throw on a storage failure — the
   *  recorder's behavior on that throw depends on `throwOnStorageError`. */
  record: (interaction: ScenarioInteraction) => void;
}

export interface CreateRecordingFetchOptions {
  /**
   * Verification-mode flag (per the task spec: "any storage error →
   * complete:false and (in verification mode flag) throw"). When true, a
   * sink.record() failure is fatal — the recording run aborts rather than
   * silently continuing with a hole in the transcript. Default false.
   */
  throwOnStorageError?: boolean;
}

/** In-memory implementation of RecordSink; the spike's default sink. */
export function createInMemoryRecordSink(): RecordSink & {
  interactions: ScenarioInteraction[];
  normalizers: ScenarioNormalizer[];
} {
  const interactions: ScenarioInteraction[] = [];
  const normalizers: ScenarioNormalizer[] = [];
  let storageFailed = false;
  return {
    interactions,
    normalizers,
    record(interaction: ScenarioInteraction): void {
      try {
        interactions.push(interaction);
      } catch (err) {
        storageFailed = true;
        throw err;
      }
    },
    finalize(): { complete: boolean } {
      return { complete: !storageFailed };
    },
  };
}

/** Provenance of one provider-issued value: which interaction `seq` served
 *  it, and the `json_path` within that response body where it was found —
 *  exactly the two fields a `ScenarioBinding` needs. Mirrors
 *  subprocess-fetch-preloads.ts's `providerIssuedValues` Map (value ->
 *  {seq, path}) so both recorders resolve provenance identically. */
interface ProviderValueProvenance {
  jsonPath: string;
  sourceSeq: number;
}

/** JSON-Pointer-ish dot/bracket path builder — mirrors
 *  subprocess-fetch-preloads.ts's inline `walkForProviderValues` path
 *  construction (`.key` for a plain identifier, `[JSON.stringify(key)]`
 *  otherwise) so `json_path` strings built by either recorder resolve
 *  identically against `replay.ts`'s `resolveJsonPath`. */
const PLAIN_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function pathSegment(key: string): string {
  return PLAIN_IDENTIFIER_RE.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/**
 * Walks a parsed response body and records the FIRST sighting of every
 * string leaf value of at least `MIN_PROVIDER_VALUE_LENGTH` characters into
 * `providerIssuedValues`, up to `MAX_PROVIDER_VALUES` total, keyed by the
 * value itself with its `{seq, json_path}` provenance — the source a later
 * request's matching credential-shaped param becomes a `ScenarioBinding`
 * against, rather than a bare presence check. Bounded and simple by design:
 * a false positive (an unrelated string that happens to equal a later
 * credential value) merely stops redacting a param that coincidentally never
 * needed to be a secret in this recording — the failure mode is not a
 * security hole, so a cheap/approximate walk is sufficient.
 */
function collectProviderIssuedValues(
  body: unknown,
  seq: number,
  path: string,
  providerIssuedValues: Map<string, ProviderValueProvenance>
): void {
  if (providerIssuedValues.size >= MAX_PROVIDER_VALUES) {
    return;
  }
  if (typeof body === "string") {
    if (body.length >= MIN_PROVIDER_VALUE_LENGTH && !providerIssuedValues.has(body)) {
      providerIssuedValues.set(body, { sourceSeq: seq, jsonPath: path });
    }
    return;
  }
  if (Array.isArray(body)) {
    body.forEach((item, index) => {
      if (providerIssuedValues.size < MAX_PROVIDER_VALUES) {
        collectProviderIssuedValues(item, seq, `${path}[${String(index)}]`, providerIssuedValues);
      }
    });
    return;
  }
  if (body !== null && typeof body === "object") {
    for (const [key, value] of Object.entries(body)) {
      if (providerIssuedValues.size >= MAX_PROVIDER_VALUES) {
        return;
      }
      collectProviderIssuedValues(value, seq, `${path}${pathSegment(key)}`, providerIssuedValues);
    }
  }
}

/**
 * Splits a request URL's credential-shaped query params into `kept`
 * (non-credential params, sorted), `bindings` (credential-shaped params
 * whose value was provider-issued — resolved from an earlier response in
 * this run), and `seenNormalizers` (credential-shaped params that were NOT
 * provider-issued — genuine client-supplied secrets, redacted as before).
 * Mirrors subprocess-fetch-preloads.ts's inline RECORD preload logic exactly
 * — see this module's doc comment for why the two must never diverge.
 */
function collectRedactedQueryParams(
  url: URL,
  seenNormalizers: Map<string, string>,
  providerIssuedValues: ReadonlyMap<string, ProviderValueProvenance>
): { bindings: ScenarioBinding[]; kept: [string, string][] } {
  const kept: [string, string][] = [];
  const bindings: ScenarioBinding[] = [];
  for (const [name, value] of url.searchParams.entries()) {
    if (CREDENTIAL_QUERY_PARAM_RE.test(name)) {
      const provenance = providerIssuedValues.get(value);
      if (provenance) {
        bindings.push({ param: name, source_seq: provenance.sourceSeq, json_path: provenance.jsonPath });
        continue;
      }
      if (!seenNormalizers.has(name)) {
        seenNormalizers.set(name, "credential");
      }
      continue;
    }
    kept.push([name, value]);
  }
  kept.sort(compareQueryPair);
  return { kept, bindings };
}

function bodySha256(bodyBytes: Uint8Array | null): string | undefined {
  if (bodyBytes === null) {
    return;
  }
  return createHash("sha256").update(bodyBytes).digest("hex");
}

/**
 * Reads the request body (if any) via `Request.clone().arrayBuffer()` — the
 * one path that works uniformly regardless of whether the caller passed a
 * string/Uint8Array/ArrayBuffer/Blob body, since the Fetch API's `Request`
 * constructor normalizes all of those into its own internal body stream.
 * Returns null when the request has no body (GET/HEAD, or no body option).
 */
async function requestBodyBytes(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) {
    return null;
  }
  const buf = await request.clone().arrayBuffer();
  return new Uint8Array(buf);
}

async function readResponseBodyForStorage(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const buf = new Uint8Array(await response.clone().arrayBuffer());
  if (buf.byteLength > MAX_STORED_BODY_BYTES) {
    return { bytes: buf.subarray(0, MAX_STORED_BODY_BYTES), truncated: true };
  }
  return { bytes: buf, truncated: false };
}

function parseStoredBody(bytes: Uint8Array, contentType: string | undefined, truncated: boolean): unknown {
  if (truncated) {
    // A truncated body can't be safely JSON-parsed (it may be cut mid-token).
    // Store it as a marker object rather than corrupt/misleading JSON.
    return { __scenario_body_truncated__: true, stored_bytes: bytes.byteLength };
  }
  const text = new TextDecoder().decode(bytes);
  if (contentType?.includes("json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

export interface RecordingFetch {
  /** Every credential-like query param name stripped so far, mapped to the
   *  redaction reason. Read after a run completes and merge into the
   *  scenario's top-level `normalizers` list. */
  discoveredNormalizers: () => ScenarioNormalizer[];
  fetch: typeof fetch;
}

/**
 * Wrap `underlying` (a real or synthetic `fetch`) so every request/response
 * pair it handles is recorded into `sink` as a `ScenarioInteraction`, in
 * call order. Redaction (headers stripped, credential-like query params
 * dropped + normalized) happens before `sink.record` ever sees the
 * interaction — nothing sensitive is constructed, let alone persisted.
 */
export function createRecordingFetch(
  underlying: typeof fetch,
  sink: RecordSink,
  options: CreateRecordingFetchOptions = {}
): RecordingFetch {
  let seq = 0;
  const seenNormalizers = new Map<string, string>();
  // Provider-issued values seen so far in THIS run, with provenance
  // ({sourceSeq, jsonPath}) — populated from every recorded response body
  // BEFORE the next request is processed (requests and responses are
  // handled strictly in call order below, so a value only ever resolves a
  // binding for requests that come after the response it was extracted
  // from). FIX 4: a Map (not a Set) so a matching credential-shaped param
  // becomes a `ScenarioBinding` naming exactly which earlier response served
  // it, rather than merely excusing it from redaction while keeping it raw.
  const providerIssuedValues = new Map<string, ProviderValueProvenance>();

  const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    // Headers (authorization/cookie/set-cookie/x-csrf-*) are redacted
    // structurally: `ScenarioRequest` has no header field at all, and
    // nothing below ever reads `request.headers`/`response.headers` for the
    // purpose of writing them into the interaction. There is no header
    // value anywhere in this function's data flow from here on.

    const { kept: query, bindings } = collectRedactedQueryParams(url, seenNormalizers, providerIssuedValues);
    const bodyBytes = await requestBodyBytes(request);
    const bodyHash = bodySha256(bodyBytes);

    const response = await underlying(input, init);

    seq += 1;
    const { bytes, truncated } = await readResponseBodyForStorage(response);
    const contentType = response.headers.get("content-type") ?? undefined;
    const parsedBody = parseStoredBody(bytes, contentType, truncated);
    // FIX 4 finding: `replay.ts`'s `resolveJsonPath` (the function that
    // actually consumes this `json_path` at replay time) documents/expects
    // paths WITHOUT a leading root marker (its own doc comment's examples:
    // `data.cursor`, `items[0].id`) — it splits on `.` and drops empty
    // segments, so starting from "" here (not "$") produces a bare
    // `next_token` for a top-level field, which resolves correctly. Starting
    // from "$" (subprocess-fetch-preloads.ts's inline preload does this) would
    // produce "$.next_token", which resolveJsonPath treats "$" as a literal
    // object key that doesn't exist — a resolution failure for exactly the
    // common top-level-field case. This module matches resolveJsonPath's
    // actual documented contract rather than the preload's convention.
    collectProviderIssuedValues(parsedBody, seq, "", providerIssuedValues);

    const interaction: ScenarioInteraction = {
      seq,
      request: {
        method: request.method,
        origin: url.origin,
        path: url.pathname,
        query,
        ...(bodyHash === undefined ? {} : { body_sha256: bodyHash }),
      },
      response: {
        status: response.status,
        body: parsedBody,
        ...(contentType === undefined ? {} : { content_type: contentType }),
      },
      ...(bindings.length > 0 ? { bindings } : {}),
    };

    try {
      sink.record(interaction);
    } catch (err) {
      if (options.throwOnStorageError) {
        throw err;
      }
    }

    return response;
  }) as typeof fetch;

  return {
    fetch: recordingFetch,
    discoveredNormalizers: (): ScenarioNormalizer[] =>
      [...seenNormalizers].map(([param, reason]) => ({ param, reason })),
  };
}
