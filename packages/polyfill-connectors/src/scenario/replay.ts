// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Strictly offline replay `fetch` for a single scenario run. `createReplayFetch`
 * never touches the network by construction — the only data source it reads
 * from is `scenarioRun.interactions`, already materialized in memory.
 *
 * Matching is intentionally strict: method + origin + path + sorted
 * normalized query + body_sha256 (when the recorded interaction has one).
 * Interactions sharing the same match key are consumed strictly in recorded
 * order (a FIFO per key), so a connector issuing the "same" request twice in
 * a row (e.g. re-polling the same endpoint on two pages of a cursor loop)
 * gets each recorded response exactly once, in the order they were captured.
 *
 * NORMALIZER MISUSE GUARD: a normalizer strips a query param from the match
 * key entirely, which means two interactions that differ ONLY in that
 * param's value (e.g. `page=1` vs `page=2`) collapse onto the SAME key and
 * become a FIFO queue. That is exactly right for a genuinely volatile,
 * provider-issued value (a `next_token` the server handed back in an
 * earlier response) — the request's value can't be predicted at match time,
 * so the match key can't include it. It is exactly WRONG for a static,
 * caller-controlled value like a `page` number: if the collector's actual
 * request order ever diverges from recorded order (a bug, a retry, or a
 * hostile scenario file), the FIFO queue silently serves page 2's recorded
 * response to a request that asked for page 1, or vice versa — the record
 * counts might still add up while individual records are swapped.
 *
 * The guard: when a request matches an interaction's key, for every
 * normalized param present in BOTH the request and the recorded
 * interaction whose values differ, the request's value must appear in the
 * `providerIssuedValues` set this module collects from response bodies
 * ALREADY SERVED during this replay run (same "string leaf >= 8 chars,
 * capped" rule as record.ts's `collectProviderIssuedValues`, so a value
 * only counts as provider-issued once its origin response has actually been
 * replayed, matching the causal order the real recording process observed
 * it in). A differing value that never appeared in an earlier served
 * response is not something the provider could have handed the collector —
 * it is either a hardcoded/guessed value or an out-of-order replay, and
 * `createReplayFetch` throws `ScenarioMismatchError` naming the param
 * rather than silently serving whatever the FIFO cursor happens to point
 * at.
 *
 * BINDING RESOLUTION (format.ts's `ScenarioInteraction.bindings`): a bound
 * query param (e.g. an OAuth-issued cursor) is excluded from its OWN
 * interaction's match key — same rationale as a normalizer, but declared
 * per-interaction rather than scenario-wide — and is instead checked
 * separately once an interaction is otherwise matched: the live request
 * must carry the bound param, and its value must equal the value resolved
 * from the response body THIS REPLAY RUN ACTUALLY SERVED for the binding's
 * `source_seq`, at `json_path`. A missing param or a differing value throws
 * `ScenarioBindingMismatchError` naming the binding, rather than silently
 * matching (or silently failing to match) on a key that happened to still
 * line up.
 */

import { createHash } from "node:crypto";
import type {
  ConnectorScenario,
  ScenarioBinding,
  ScenarioInteraction,
  ScenarioNormalizer,
  ScenarioRun,
} from "./format.ts";

/** Minimum string length to be considered a candidate provider-issued
 *  value — mirrors record.ts's MIN_PROVIDER_VALUE_LENGTH so the "was this
 *  value provider-issued" question is answered the same way on both the
 *  record and replay sides. */
const MIN_PROVIDER_VALUE_LENGTH = 8;
/** Caps the per-run provider-issued-value set — mirrors record.ts's
 *  MAX_PROVIDER_VALUES. */
const MAX_PROVIDER_VALUES = 10_000;

export type MatchKeyComponent = "body_sha256" | "method" | "origin" | "path" | "query";

/** Sorts [name, value] query pairs by name. */
function compareQueryPair(pairA: [string, string], pairB: [string, string]): number {
  return pairA[0].localeCompare(pairB[0]);
}

export interface NearestMissDiff {
  actual: unknown;
  component: MatchKeyComponent;
  expected: unknown;
}

export class ScenarioMismatchError extends Error {
  readonly nearestMiss: NearestMissDiff | null;
  readonly requestSummary: string;

  constructor(message: string, options: { nearestMiss: NearestMissDiff | null; requestSummary: string }) {
    super(message);
    this.name = "ScenarioMismatchError";
    this.nearestMiss = options.nearestMiss;
    this.requestSummary = options.requestSummary;
  }
}

export class UnconsumedInteractionsError extends Error {
  readonly unconsumedSeqs: number[];

  constructor(unconsumedSeqs: number[]) {
    super(
      `scenario replay: ${unconsumedSeqs.length} interaction(s) never consumed: seq [${unconsumedSeqs.join(", ")}]`
    );
    this.name = "UnconsumedInteractionsError";
    this.unconsumedSeqs = unconsumedSeqs;
  }
}

/**
 * FIX 6 — binding resolution failure. Thrown when a bound query param is
 * missing from the live request, or when the live request's value for a
 * bound param differs from the value the matcher resolved from the response
 * ACTUALLY SERVED for the binding's `source_seq` at `json_path` (see
 * `resolveBindingExpectedValue` below). Named separately from
 * `ScenarioMismatchError` so a caller can distinguish "no recorded
 * interaction matches this request at all" from "a request matched an
 * interaction, but a provider-issued cursor/param it carried does not match
 * what this replay run actually served earlier".
 */
export class ScenarioBindingMismatchError extends Error {
  readonly binding: ScenarioBinding;
  readonly interactionSeq: number;

  constructor(message: string, options: { binding: ScenarioBinding; interactionSeq: number }) {
    super(message);
    this.name = "ScenarioBindingMismatchError";
    this.binding = options.binding;
    this.interactionSeq = options.interactionSeq;
  }
}

export interface ReplayFetch {
  /** Throws UnconsumedInteractionsError listing every seq that was never
   *  matched by a request during replay. Call after the run finishes. */
  assertAllConsumed: () => void;
  fetch: typeof fetch;
}

function normalizedParamNames(normalizers: readonly ScenarioNormalizer[] | undefined): ReadonlySet<string> {
  return new Set((normalizers ?? []).map((n) => n.param));
}

/** The set of query param names a single interaction declares as bound
 *  (format.ts's `ScenarioInteraction.bindings`). Empty when the interaction
 *  has no bindings. */
function boundParamNames(interaction: ScenarioInteraction): ReadonlySet<string> {
  return new Set((interaction.bindings ?? []).map((b) => b.param));
}

/**
 * Resolves a simple dot/bracket `json_path` (e.g. `data.cursor`,
 * `items[0].id`, `data.next.token`) against a parsed response body.
 * Supports only plain object-property and numeric-array-index steps — no
 * wildcards, filters, or slicing. Returns `undefined` when any step along
 * the path is missing or the wrong shape (object step against a
 * non-object, index step against a non-array/out-of-range) rather than
 * throwing, so the caller can produce one consistent "could not resolve"
 * error message instead of a raw property-access exception.
 */
function resolveJsonPath(body: unknown, path: string): unknown {
  // Split "items[0].id" into ["items", "0", "id"] — bracket segments are
  // normalized to dot segments before splitting, so both dot and bracket
  // notation share one walk loop.
  const normalized = path.replace(/\[(\d+)\]/g, ".$1");
  const steps = normalized.split(".").filter((step) => step.length > 0);

  let current: unknown = body;
  for (const step of steps) {
    if (current === null || current === undefined) {
      return;
    }
    if (Array.isArray(current)) {
      const index = Number(step);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return;
      }
      current = current[index];
      continue;
    }
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[step];
      continue;
    }
    return;
  }
  return current;
}

/**
 * The strict match key: method + origin + path + sorted query (normalizer
 * params excluded) + body_sha256 when present. Returned as a JSON string so
 * it can be used as a Map key without a manual tuple-hashing scheme.
 */
function matchKey(
  parts: {
    bodySha256: string | undefined;
    method: string;
    origin: string;
    path: string;
    query: [string, string][];
  },
  normalizedNames: ReadonlySet<string>
): string {
  const filteredQuery = parts.query.filter(([name]) => !normalizedNames.has(name));
  filteredQuery.sort(compareQueryPair);
  return JSON.stringify({
    method: parts.method,
    origin: parts.origin,
    path: parts.path,
    query: filteredQuery,
    body_sha256: parts.bodySha256 ?? null,
  });
}

function queryFromUrl(url: URL): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [name, value] of url.searchParams.entries()) {
    pairs.push([name, value]);
  }
  return pairs;
}

/**
 * Walks a parsed response body and adds every string leaf value of at least
 * `MIN_PROVIDER_VALUE_LENGTH` characters into `providerIssuedValues`, up to
 * `MAX_PROVIDER_VALUES` total. Deliberately the same shape as record.ts's
 * `collectProviderIssuedValues` (see that module's doc for the rationale) —
 * replay needs the identical "was this value provider-issued" answer the
 * recorder used, or a value the recorder treated as provider-issued (and so
 * never stripped from a request) would wrongly fail this guard on replay.
 */
function collectProviderIssuedValues(body: unknown, providerIssuedValues: Set<string>): void {
  if (providerIssuedValues.size >= MAX_PROVIDER_VALUES) {
    return;
  }
  if (typeof body === "string") {
    if (body.length >= MIN_PROVIDER_VALUE_LENGTH) {
      providerIssuedValues.add(body);
    }
    return;
  }
  if (Array.isArray(body)) {
    for (const item of body) {
      if (providerIssuedValues.size >= MAX_PROVIDER_VALUES) {
        return;
      }
      collectProviderIssuedValues(item, providerIssuedValues);
    }
    return;
  }
  if (body !== null && typeof body === "object") {
    for (const value of Object.values(body)) {
      if (providerIssuedValues.size >= MAX_PROVIDER_VALUES) {
        return;
      }
      collectProviderIssuedValues(value, providerIssuedValues);
    }
  }
}

/**
 * Checks every normalized param present in BOTH `requestedQuery` and
 * `interaction.request.query` for the normalizer-misuse guard described in
 * this module's doc comment: a differing value is only legitimate when it
 * appears in `providerIssuedValues` (response bodies already served earlier
 * in this replay run). Returns the first offending param name, or null when
 * every differing normalized param is accounted for.
 */
function findUnaccountedNormalizerMismatch(
  requestedQuery: readonly [string, string][],
  interaction: ScenarioInteraction,
  normalizedNames: ReadonlySet<string>,
  providerIssuedValues: ReadonlySet<string>
): string | null {
  const recordedByName = new Map(interaction.request.query);
  const requestedByName = new Map(requestedQuery);
  for (const name of normalizedNames) {
    const recordedValue = recordedByName.get(name);
    const requestedValue = requestedByName.get(name);
    if (recordedValue === undefined || requestedValue === undefined) {
      // Not present on both sides — nothing to compare for this param.
      continue;
    }
    if (recordedValue === requestedValue) {
      continue;
    }
    if (!providerIssuedValues.has(requestedValue)) {
      return name;
    }
  }
  return null;
}

async function bodySha256(request: Request): Promise<string | undefined> {
  if (request.body === null) {
    return;
  }
  const buf = await request.clone().arrayBuffer();
  return createHash("sha256").update(new Uint8Array(buf)).digest("hex");
}

/**
 * Diff a request against the interaction whose key is "closest" (most
 * matching components) among interactions that share the request's method.
 * Used only to build a helpful ScenarioMismatchError — never affects
 * matching itself.
 */
function findNearestMiss(
  requested: {
    bodySha256: string | undefined;
    method: string;
    origin: string;
    path: string;
    query: [string, string][];
  },
  candidates: readonly ScenarioInteraction[],
  normalizedNames: ReadonlySet<string>
): NearestMissDiff | null {
  const sameMethod = candidates.filter((c) => c.request.method === requested.method);
  const pool = sameMethod.length > 0 ? sameMethod : candidates;
  if (pool.length === 0) {
    return null;
  }

  const requestedFilteredQuery = requested.query.filter(([name]) => !normalizedNames.has(name)).sort(compareQueryPair);

  let best: { diff: NearestMissDiff; score: number } | null = null;
  for (const candidate of pool) {
    const component = firstDifferingComponent(requested, requestedFilteredQuery, candidate, normalizedNames);
    if (component === null) {
      continue;
    }
    const score = componentPriority(component);
    if (!best || score < best.score) {
      best = { diff: component, score };
    }
  }
  return best?.diff ?? null;
}

function componentPriority(diff: NearestMissDiff): number {
  const order: Record<MatchKeyComponent, number> = { method: 0, origin: 1, path: 2, query: 3, body_sha256: 4 };
  return order[diff.component];
}

function firstDifferingComponent(
  requested: { bodySha256: string | undefined; method: string; origin: string; path: string },
  requestedFilteredQuery: [string, string][],
  candidate: ScenarioInteraction,
  normalizedNames: ReadonlySet<string>
): NearestMissDiff | null {
  if (candidate.request.method !== requested.method) {
    return { component: "method", expected: candidate.request.method, actual: requested.method };
  }
  if (candidate.request.origin !== requested.origin) {
    return { component: "origin", expected: candidate.request.origin, actual: requested.origin };
  }
  if (candidate.request.path !== requested.path) {
    return { component: "path", expected: candidate.request.path, actual: requested.path };
  }
  const candidateFilteredQuery = candidate.request.query.filter(([name]) => !normalizedNames.has(name));
  if (JSON.stringify(candidateFilteredQuery) !== JSON.stringify(requestedFilteredQuery)) {
    return { component: "query", expected: candidateFilteredQuery, actual: requestedFilteredQuery };
  }
  if ((candidate.request.body_sha256 ?? null) !== (requested.bodySha256 ?? null)) {
    return {
      component: "body_sha256",
      expected: candidate.request.body_sha256 ?? null,
      actual: requested.bodySha256 ?? null,
    };
  }
  return null;
}

function bodyToResponseInit(response: ScenarioInteraction["response"]): ResponseInit {
  // Recorded allowlisted headers (retry-after, etag, link, ...) are served
  // back so header-dependent connector control flow replays faithfully;
  // content_type wins over any recorded content-type duplicate.
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers ?? []) {
    headers[name] = value;
  }
  if (response.content_type !== undefined) {
    headers["content-type"] = response.content_type;
  }
  return {
    status: response.status,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function serializeResponseBody(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

/**
 * Build a strictly offline replay `fetch` for one scenario run. Each request
 * consumes the next not-yet-consumed interaction whose match key equals the
 * request's (same-key interactions are a FIFO queue in recorded seq order).
 * An unmatched request throws `ScenarioMismatchError`.
 */
export function createReplayFetch(
  scenarioRun: ScenarioRun,
  normalizers: readonly ScenarioNormalizer[] | undefined = []
): ReplayFetch {
  const normalizedNames = normalizedParamNames(normalizers);

  // FIX 6(d): a bound param's value must never appear in the match key —
  // its value is resolved from an earlier response, not compared as a
  // static string, so including it in the key would make two requests that
  // legitimately differ only by that provider-issued value fail to match
  // the same recorded interaction. Bindings are declared PER INTERACTION
  // (not scenario-wide like normalizers), so each interaction's own
  // exclusion set is `normalizedNames ∪ boundParamNames(interaction)` — two
  // interactions at the same method/origin/path can therefore have
  // DIFFERENT exclusion sets when they bind different params. `byKey` groups
  // by each interaction's own effective key; matching an incoming live
  // request (which doesn't know a priori which interaction it targets, so
  // doesn't know which params are "bound" yet) tries every distinct
  // exclusion set observed among candidate interactions until one produces
  // a hit — see `keyForRequestAgainstInteraction` below.
  const byKey = new Map<string, ScenarioInteraction[]>();
  const exclusionSetsSeen: ReadonlySet<string>[] = [];
  for (const interaction of scenarioRun.interactions) {
    const exclusionSet = new Set<string>([...normalizedNames, ...boundParamNames(interaction)]);
    exclusionSetsSeen.push(exclusionSet);
    const key = matchKey(
      {
        method: interaction.request.method,
        origin: interaction.request.origin,
        path: interaction.request.path,
        query: interaction.request.query,
        bodySha256: interaction.request.body_sha256,
      },
      exclusionSet
    );
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(interaction);
    } else {
      byKey.set(key, [interaction]);
    }
  }
  // Deduplicated distinct exclusion sets, each rendered as a sorted-name
  // JSON array so two interactions with the same bound param names (in any
  // declaration order) collapse onto the same candidate exclusion set
  // instead of being tried twice.
  const distinctExclusionSets: ReadonlySet<string>[] = (() => {
    const seenSerialized = new Set<string>();
    const distinct: ReadonlySet<string>[] = [];
    for (const set of exclusionSetsSeen) {
      const serialized = JSON.stringify([...set].sort());
      if (!seenSerialized.has(serialized)) {
        seenSerialized.add(serialized);
        distinct.push(set);
      }
    }
    // The plain normalizer-only exclusion set is always tried too (covers
    // an incoming request that should match a NO-bindings interaction, and
    // is also the base case when the run has zero bindings at all).
    const normalizerOnlySerialized = JSON.stringify([...normalizedNames].sort());
    if (!seenSerialized.has(normalizerOnlySerialized)) {
      distinct.push(normalizedNames);
    }
    return distinct;
  })();
  const cursorByKey = new Map<string, number>();
  const consumedSeqs = new Set<number>();
  // Response bodies already served during THIS replay run, by the serving
  // interaction's `seq` — the source of truth `resolveBindingExpectedValue`
  // reads from for a binding's `source_seq`/`json_path` (FIX 6(b): "the
  // response body it ACTUALLY SERVED", never the scenario's own recorded
  // response for source_seq blindly — those happen to be the same bytes in
  // this harness since replay serves recorded bodies verbatim, but reading
  // from `servedResponseBodies` keeps the binding check honestly scoped to
  // "what this replay run served", not "what the file says").
  const servedResponseBodies = new Map<number, unknown>();
  // Provider-issued values seen so far in THIS replay run, populated from
  // every response body AFTER it is served (see the normalizer-misuse guard
  // in this module's doc comment) — a later request's differing normalized
  // param value is only legitimate if it was actually handed out by an
  // EARLIER response in this same run, mirroring the causal order the real
  // recorder observed.
  const providerIssuedValues = new Set<string>();

  /**
   * FIX 6(a)/(b)/(c): validates ONE binding against the live request that
   * matched the interaction declaring it. Split out of
   * `assertBindingsSatisfied` purely to keep that function's (and this
   * module's cognitive-complexity) under this package's lint ceiling —
   * behavior is unchanged from the inline version.
   *   (a) the live request must carry the bound param at all;
   *   (b) the expected value is resolved from the response body ACTUALLY
   *       SERVED (this run) for the binding's `source_seq`, at `json_path`;
   *   (c) a live value differing from the resolved expected value throws a
   *       named `ScenarioBindingMismatchError`, not a silent pass.
   */
  function checkOneBinding(
    interaction: ScenarioInteraction,
    binding: ScenarioBinding,
    requestedByName: ReadonlyMap<string, string>
  ): void {
    const liveValue = requestedByName.get(binding.param);
    if (liveValue === undefined) {
      throw new ScenarioBindingMismatchError(
        `scenario replay: interaction seq ${String(interaction.seq)} declares a binding for query param "${binding.param}" ` +
          `(from source_seq ${String(binding.source_seq)} at "${binding.json_path}") but the live request does not carry that param at all`,
        { binding, interactionSeq: interaction.seq }
      );
    }
    if (!servedResponseBodies.has(binding.source_seq)) {
      throw new ScenarioBindingMismatchError(
        `scenario replay: interaction seq ${String(interaction.seq)} declares a binding sourced from seq ${String(binding.source_seq)}, ` +
          "but no response has been served for that seq yet in this replay run — the binding's source_seq must be an EARLIER interaction in actual serve order",
        { binding, interactionSeq: interaction.seq }
      );
    }
    const sourceBody = servedResponseBodies.get(binding.source_seq);
    const expectedValue = resolveJsonPath(sourceBody, binding.json_path);
    if (expectedValue === undefined) {
      throw new ScenarioBindingMismatchError(
        `scenario replay: interaction seq ${String(interaction.seq)}'s binding for "${binding.param}" could not resolve json_path "${binding.json_path}" ` +
          `against the response actually served for source_seq ${String(binding.source_seq)}`,
        { binding, interactionSeq: interaction.seq }
      );
    }
    const expectedAsString = typeof expectedValue === "string" ? expectedValue : JSON.stringify(expectedValue);
    if (liveValue !== expectedAsString) {
      throw new ScenarioBindingMismatchError(
        `scenario replay: interaction seq ${String(interaction.seq)}'s bound param "${binding.param}" mismatch — ` +
          `live request carried ${JSON.stringify(liveValue)}, but the response actually served for source_seq ${String(binding.source_seq)} at "${binding.json_path}" was ${JSON.stringify(expectedAsString)}`,
        { binding, interactionSeq: interaction.seq }
      );
    }
  }

  /**
   * Validates every binding an already-matched `interaction` declares
   * against the live request that matched it — see `checkOneBinding` for
   * the per-binding rules. Returns nothing (throws on the first failing
   * binding) — called before an interaction is consumed, so a binding
   * failure never marks the interaction as served.
   */
  function assertBindingsSatisfied(
    interaction: ScenarioInteraction,
    requestedQuery: readonly [string, string][]
  ): void {
    if (!interaction.bindings || interaction.bindings.length === 0) {
      return;
    }
    const requestedByName = new Map(requestedQuery);
    for (const binding of interaction.bindings) {
      checkOneBinding(interaction, binding, requestedByName);
    }
  }

  /** Tries every distinct exclusion set until one yields a not-yet-consumed
   *  candidate interaction whose key equals the live request's key built
   *  with that same exclusion set. Returns the matched interaction, the key
   *  it matched under, and the bucket cursor — or null when no exclusion
   *  set yields a match. */
  function findMatchingInteraction(requested: {
    bodySha256: string | undefined;
    method: string;
    origin: string;
    path: string;
    query: [string, string][];
  }): { cursor: number; interaction: ScenarioInteraction; key: string } | null {
    for (const exclusionSet of distinctExclusionSets) {
      const key = matchKey(requested, exclusionSet);
      const bucket = byKey.get(key);
      if (!bucket) {
        continue;
      }
      const cursor = cursorByKey.get(key) ?? 0;
      const interaction = bucket[cursor];
      if (interaction) {
        return { interaction, key, cursor };
      }
    }
    return null;
  }

  const replayFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const requested = {
      method: request.method,
      origin: url.origin,
      path: url.pathname,
      query: queryFromUrl(url),
      bodySha256: await bodySha256(request),
    };
    const found = findMatchingInteraction(requested);

    if (!found) {
      const nearestMiss = findNearestMiss(requested, scenarioRun.interactions, normalizedNames);
      const requestSummary = `${requested.method} ${requested.origin}${requested.path}?${new URLSearchParams(requested.query).toString()}`;
      throw new ScenarioMismatchError(
        `scenario replay: no recorded interaction matches request ${requestSummary}` +
          (nearestMiss
            ? ` (nearest miss: ${nearestMiss.component} expected=${JSON.stringify(nearestMiss.expected)} actual=${JSON.stringify(nearestMiss.actual)})`
            : " (no candidate interaction shares even the method)"),
        { nearestMiss, requestSummary }
      );
    }
    const { interaction, key, cursor } = found;

    const unaccountedParam = findUnaccountedNormalizerMismatch(
      requested.query,
      interaction,
      normalizedNames,
      providerIssuedValues
    );
    if (unaccountedParam !== null) {
      const requestSummary = `${requested.method} ${requested.origin}${requested.path}?${new URLSearchParams(requested.query).toString()}`;
      throw new ScenarioMismatchError(
        `scenario replay: normalized query param "${unaccountedParam}" differs from the matched interaction (seq ${String(interaction.seq)}) and its request value was not issued by any response served earlier in this run — ` +
          "a normalizer only excuses a value the provider itself handed back; a differing value that never appeared in an earlier response is not provider-issued and may indicate the recorded interactions are being served out of order or the scenario was tampered with. " +
          `request: ${requestSummary}`,
        { nearestMiss: null, requestSummary }
      );
    }

    // FIX 6: validate bindings BEFORE consuming — a binding failure must
    // not mark the interaction as served (the request never got a valid
    // response in that case).
    assertBindingsSatisfied(interaction, requested.query);

    cursorByKey.set(key, cursor + 1);
    consumedSeqs.add(interaction.seq);

    collectProviderIssuedValues(interaction.response.body, providerIssuedValues);
    servedResponseBodies.set(interaction.seq, interaction.response.body);

    return new Response(serializeResponseBody(interaction.response.body), bodyToResponseInit(interaction.response));
  }) as typeof fetch;

  return {
    fetch: replayFetch,
    assertAllConsumed(): void {
      const unconsumed = scenarioRun.interactions.filter((i) => !consumedSeqs.has(i.seq)).map((i) => i.seq);
      if (unconsumed.length > 0) {
        throw new UnconsumedInteractionsError(unconsumed);
      }
    },
  };
}

/** Convenience: normalizers live at the scenario level, not per-run — this
 *  reads them off the top-level scenario for a given run index. */
export function createReplayFetchForRun(scenario: ConnectorScenario, runIndex: number): ReplayFetch {
  const run = scenario.runs[runIndex];
  if (!run) {
    throw new Error(`createReplayFetchForRun: scenario has no run at index ${String(runIndex)}`);
  }
  return createReplayFetch(run, scenario.normalizers);
}
