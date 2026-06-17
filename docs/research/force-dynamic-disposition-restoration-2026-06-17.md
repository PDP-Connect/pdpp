# Force-dynamic disposition → SLVP-ideal restoration design

**Status:** AUDIT + DESIGN ONLY. No code written. For owner (the owner) + RI owner (Codex) review before any change.
**Date:** 2026-06-17
**Author:** disposition synthesis subagent
**Scope:** `apps/console/src/app/dashboard/**` route-level `export const dynamic = "force-dynamic"` directives.

---

## 0. Problem statement (the offender)

~21 dashboard pages carry `export const dynamic = "force-dynamic"`. That directive opts the
route out of all caching and forces a fresh RSC render per navigation. On the **runs** route
this is the proven root cause of 2–5 repeated RSC fetches stacking into a 7–12s load. The 2026
Next.js ideal is **static shell + fine-grained `Suspense` + searchParams read inside a child**
(PPR's mental model), so the cacheable chrome paints instantly and only the genuinely
request-dependent holes stream.

the owner wants this restored to the ideal — **conservatively**. Genuinely-dynamic pages must not
break. This doc is the disposition map + the shared fix + a rollout that pilots on the proven
offender first.

### Ground-truth corrections found while verifying the audit (read these before trusting line cites)

The disposition design must be verifiable, so the page files were read. Three audit claims do
not match the source and are corrected here:

1. **`runs/page.tsx` is 98 lines, not ~981.** The must-stay objection cites
   `verifyDashboardSession() line 981` and `?peek redirect lines 51-53`. The peek redirect is
   real (lines 51–53), but **the runs page never calls `verifyDashboardSession`** — `grep`
   confirms zero references in `runs/`. The "auth must run at line 981 before serving" argument
   is built on a fabricated line. The *underlying* freshness point still stands via a different,
   real mechanism (below), so the page stays dynamic — but for the right reason.

2. **Auth is a Data-Access-Layer concern, not a route-directive concern.** `verify-session.ts`
   is explicit: *"every dashboard data fetch verifies the owner session here, close to the data
   source, **not in a layout**"*, and it is memoized with React `cache()`. Auth runs inside the
   fetchers (`rs-client.ts`, `ref-client.ts`, `owner-token.ts`), all of which read `cookies()`
   and set `cache: "no-store"`. **`cookies()` is a Dynamic API in Next 16** — any component that
   transitively calls it is dynamic *whether or not the route declares `force-dynamic`*. So for
   the auth-only pages, the route-level directive is **redundant for auth**: removing it cannot
   create an auth leak, because the cookie read inside the fetcher still forces that subtree
   dynamic and re-validates per request. This is what makes the "safe set" genuinely safe.

3. **Next version is 16.2.2, self-hosted `output: 'standalone'`, and `experimental.ppr` is NOT
   enabled** (`apps/console/next.config.mjs` has no `ppr` key). PPR is therefore *not currently
   active*. The shared pattern below is written to be correct **with or without** PPR — see §3.

---

## 1. Per-page disposition table

`force-dynamic`? = whether the directive exists today. Cache-safe? = verdict after analysis.

| # | Page | Why force-dynamic (today) | Classification | Cache-safe? | Disposition |
|---|------|---------------------------|----------------|-------------|-------------|
| 1 | `dashboard/traces/page.tsx` | Auth + per-request list/peek fetch; no live behavioral loop | auth-only | **YES (low risk)** | **Restore.** Static shell (`TracesHeader`, `TraceFilterBand`, `ActiveFilterChips`); wrap `TracesResults+TracePagination` in one `Suspense`, `TracePeekSlot` in another. Each child reads its own params + calls `listTraces`/`getTraceTimeline`. Auth stays in the fetcher layer (already does). |
| 2 | `connect/browser-session/[connectorId]/page.tsx` | searchParams (`?connectionId`, `?error`) read at page top → whole route dynamic | self-inflicted-cacheable | **YES (low risk)** | **Restore.** Pure render — *no data fetch at all* (only `params` validation + searchParams branching). Static shell (How-it-works, form, fallback); move the `?error`/`?connectionId` branch into one `Suspense` child returning the error banner + button label. |
| 3 | `connect/static-secret/[connectorId]/status/[connectionId]/page.tsx` | Directive on a pure redirect route | self-inflicted-cacheable | **YES (low risk)** | **Restore.** Page is a deterministic `params/searchParams → redirect(URL)`. No per-request data. Remove the directive (line 3); `redirect()` issues on every navigation regardless of cache state. |
| 4 | `dashboard/runs/page.tsx` | `?peek` redirect at page top; `liveRunCount` toggles `LivePoller`; relative timestamps need fresh fetch reference | live-poll-by-design | **NO — keep dynamic** | **Keep.** `liveRunCount` (live `listRuns` filter, l.90) drives `<LivePoller enabled=…>` — a *behavioral* enable/disable that a cached shell would freeze. `?peek` redirect (l.51–53) must run pre-render. *(Auth objection's "line 981" is wrong; keep on the real poller-loop + freshness grounds.)* This is the **pilot** in §4. |
| 5 | `dashboard/records/page.tsx` | `runningCount` (l.110-112, live `last_run.status`) drives `<RecordsPagePoller running=…>` polling cadence (3s vs 30s) | genuinely-dynamic-keep / live-poll | **NO — keep dynamic** | **Keep.** Same behavioral-contract violation as #4: live data (`runningCount`) selects component behavior (poll cadence). A cached shell can't update the poller's `running` prop when a run starts/finishes. `router.refresh()` re-renders the whole page; a static shell wouldn't help. |
| 6 | `dashboard/records/[connector]/page.tsx` | `isRunning` from `last_run.status` ("started"/"in_progress") renders "Active run →" in header (l.587-594) | searchParams-fixable (rejected) | **NO — keep dynamic** | **Keep.** Header run-state is request-time-fresh per connector, not cacheable per route param. Cached shell would show a false "Active run" button after completion. Moving searchParams to a child doesn't fix the stale-run-state leak. |
| 7 | `dashboard/records/[connector]/[stream]/page.tsx` | `PageHeader` count string + `allColumns`/`defaultColumns` derived from live `page.data` | genuinely-dynamic-keep | **NO — keep dynamic** | **Keep.** Pagination count (l.282) and column enumeration (l.185-186) depend on live data; "static across pagination" is false. Making cacheable would require relocating those derivations into dynamic holes — a layout restructure, not a directive removal. |
| 8 | `dashboard/records/[connector]/[stream]/[recordKey]/page.tsx` | Owner-scoped record payload (`Authorization: Bearer ${token}`), per-request auth | auth-only (with data-freshness) | **NO — keep dynamic** | **Keep.** Same URL yields different payloads per owner token; `record.data`/`warnings`/related-links are owner-scoped. The Suspense approach *would* technically work (shell static, hole dynamic), but the freshness + 404-on-manifest-change UX risk makes the single force-dynamic gate the honest enforcement point. Not in the conservative safe set. |
| 9 | `dashboard/records/[connector]/[stream]/health/page.tsx` | `cache:"no-store"` health metrics (null %, distinct counts, freshness ranges) | searchParams-fixable (rejected) | **NO — keep dynamic** | **Keep.** Diagnostic/observability page — stale metrics drive wrong operational decisions. searchParams is splittable, but the shell's metrics body must reflect current state every request. |
| 10 | `dashboard/records/add/page.tsx` | Per-request connection counts rendered in body copy ("N existing sources…") | searchParams-fixable (rejected) | **NO — keep dynamic** | **Keep.** Count text lives *inside* `SourceSetupCard` (the would-be static shell), derived from `listConnectorSummaries()` lifecycle state. Cached shell → stale "2 sources" when really 3. The data-dependent copy is in the shell, not a hole. |
| 11 | `dashboard/stream-playground/page.tsx` | POST to `/_ref/dev/playground/session` is a **lazy-create mutation**, mints/returns a browser session; operator-scoped | genuinely-dynamic-keep / live-poll | **NO — keep dynamic** | **Keep (strongest).** This is a semantic mutation, not a read — caching would serve a stale/consumed `run_id`+`interaction_id` to a second load. Operator-isolation + fresh-session semantics. PPR's hole can't save it; the whole point is minting a fresh session. (Prod-gated behind `PDPP_ENABLE_STREAM_PLAYGROUND=1`.) |
| 12 | `dashboard/traces/[traceId]/page.tsx` | Identity sheet, stat band, pivot links all derive from `envelope.events` fetched with per-request cursor | searchParams-fixable (rejected) | **NO — keep dynamic** | **Keep.** Entire rendered surface is cursor-dependent, not just the timeline table. Cached shell serves stale event metadata on pagination. |
| 13 | `dashboard/connect/page.tsx` | `listCimdClientDocuments()` must reflect post-action state; actions call `revalidatePath(CONNECT_PATH)` | searchParams-fixable (rejected) | **NO — keep dynamic** | **Keep.** If the parent caches the identity list, `revalidatePath()` after create/delete won't reflect on the cached shell — user sees stale list after their own mutation. The list itself must re-fetch, not just notice/error banners. |
| 14 | `dashboard/connect/status/[connectionId]/page.tsx` | Live-poll "Refresh status" UX; title + setup_state + receipt + `run_id` href all from page-level `status` fetch | searchParams-fixable (rejected) | **NO — keep dynamic** | **Keep.** "Watch a running operation progress" page; cached shell → stale setup_state/receipt and a shell/hole mismatch ("pending" shell vs "active" stream). Core utility is showing current live state. |
| 15 | `connect/browser-session/[connectorId]/launch/page.tsx` | Receives freshly-allocated, ephemeral, per-user `connection_id` from a prior `/start` POST; triggers `startBrowserRun()` | searchParams-fixable (rejected) | **NO — keep dynamic** | **Keep.** `connection_id` is server-allocated per-request state, not re-derivable from route params. Cached searchParams in the RSC response = stale/orphaned id → broken enrollment. |
| 16 | `connect/static-secret/[connectorId]/page.tsx` | Post-mutation redirect signals: `error`, `connectionId` (replace vs create mode), `field_<name>` retry values | self-inflicted-cacheable (objection) | **NO — keep dynamic** | **Keep (conservative).** Despite "self-inflicted" label, these are post-mutation redirect params that set title/mode/href; cached shell + fresh error hole risks UX desync. *Lower-confidence keep — re-examine in a later wave (§4) once the form-mode derivation is confirmed param-only.* |
| 17 | `connect/manual-upload/[connectorId]/page.tsx` | All fetches `cache:"no-store"` via `refFetch` (l.996); setup metadata (`display_name`, `description`, method cards) in shell | searchParams-fixable (rejected) | **NO — keep dynamic** | **Keep.** Developer explicitly chose no-store for connector-metadata freshness; the shell body itself carries that metadata, not a hole. |
| 18 | `dashboard/search/page.tsx` | Live run-status fields (browser-surface lease/status, needs_input); query-dependent auto-redirect (l.42-51); auth gap on non-empty queries | searchParams-fixable (rejected) | **NO — keep dynamic** | **Keep.** Live run statuses + per-request redirect logic + a real auth-isolation concern (session verify only on empty queries today). |
| 19 | `dashboard/grants/request/page.tsx` | Per-user workspace in `globalThis` (no DB), bare-UUID `workspaceId` with **no cookie binding** → cross-user; `lastError` in shell | searchParams-fixable (rejected) | **NO — keep dynamic** | **Keep (security).** Two users hitting `workspace-123` see each other's draft/client/consent. Cached shell = cross-user leak + stale errors. Strong security keep. |

> Pages not classified by the verifier (e.g. `deployment/*`, `grants/*` detail, `event-subscriptions/*`, `explore`, `schedules`, `records/stream-playground`) are **out of scope for this wave** — default to *keep dynamic* until individually verified. This doc only moves pages the verifier explicitly cleared.

### Safe set (this wave): pages 1, 2, 3 only

Three pages are cleared to become cacheable. All three are either pure-render (no data fetch) or
a deterministic redirect. None drives a live poller or renders per-request data in a would-be
static shell.

---

## 2. The shared pattern: searchParams-into-a-Suspense-child + static shell

The root anti-pattern is **reading `searchParams`/`params` at the top of the page function**,
which marks the *entire route* dynamic. The fix moves the dynamic read **down** into a child
component wrapped in `Suspense`. The page body becomes a static shell; only the child is dynamic.

### Why this works

- `searchParams` is a Dynamic API. Awaiting it at page top = whole route opts out of caching.
- If instead the page passes the *un-awaited* `searchParams` promise down to a child, and the
  child awaits it inside a `Suspense` boundary, only that child's subtree is dynamic. The shell
  prerenders.
- Auth is unaffected: it lives in the fetcher (`cookies()` + `cache:"no-store"`), which is
  itself a Dynamic API, so any child that fetches stays dynamic and re-validates per request.

### Concrete before/after (traces — page 1, the cleanest case)

**BEFORE** (whole route dynamic — current):

```tsx
export const dynamic = "force-dynamic";

export default async function TracesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;                 // ← page-top await = whole route dynamic
  const result = await listTraces(traceListFilters(params));
  const peekEnvelope = params.peek ? await getTraceTimeline(params.peek) : null;

  return (
    <RecordroomShellWithPalette>
      <TracesHeader />
      <TraceFilterBand hasFilters={hasActiveFilters(params)} params={params} />
      <TracesResults traces={result.data} params={params} hasFilters={…} />
      <TracePagination params={params} result={result} />
      <TracePeekSlot envelope={peekEnvelope} params={params} … />
    </RecordroomShellWithPalette>
  );
}
```

**AFTER** (static shell + two dynamic holes — no `force-dynamic`):

```tsx
// no `export const dynamic` — route is cacheable; the holes are dynamic.

export default function TracesPage({ searchParams }: { searchParams: Promise<Params> }) {
  // NOTE: not async, does NOT await searchParams. Shell is static/prerenderable.
  return (
    <RecordroomShellWithPalette>
      <TracesHeader />                                {/* static: pure render */}
      {/* filter band + chips need params for defaultValue/active state.
          Keep them static by reading params in a tiny child, OR pass the
          promise down. Filter inputs use `defaultValue`, so a one-frame
          empty default is acceptable; wrap in Suspense with a no-op fallback. */}
      <Suspense fallback={<FilterBandSkeleton />}>
        <TraceFilterBandAsync searchParams={searchParams} />
      </Suspense>

      <div className="rr-traces-split …">
        <div>
          <Suspense fallback={<TracesResultsSkeleton />}>
            {/* reads params + calls listTraces INSIDE the boundary */}
            <TracesResultsSection searchParams={searchParams} />
          </Suspense>
        </div>
        <Suspense fallback={null}>
          {/* conditionally calls getTraceTimeline only when params.peek */}
          <TracePeekSection searchParams={searchParams} />
        </Suspense>
      </div>
    </RecordroomShellWithPalette>
  );
}

async function TracesResultsSection({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;                 // ← await is now INSIDE the boundary
  const result = await listTraces(traceListFilters(params));   // auth runs here, per request
  if (result.data.length === 0) return <TracesEmptyState hasFilters={hasActiveFilters(params)} />;
  return (
    <>
      <TracesResults traces={result.data} params={params} hasFilters={hasActiveFilters(params)} />
      <TracePagination params={params} result={result} />
    </>
  );
}

async function TracePeekSection({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  if (!params.peek) return null;                     // no fetch unless peeking
  const envelope = await getTraceTimeline(params.peek);
  return <TracePeekSlot envelope={envelope} isPeeking params={params} traceId={params.peek} />;
}
```

The `ServerUnreachable` try/catch moves into each async section (or a shared wrapper). The
header is the only truly static node; the filter band and results are dynamic holes that stream.

For page 2 (`browser-session/[connectorId]`) the pattern is even lighter — there is **no fetch**,
so the child only branches on `?error`/`?connectionId`. For page 3 (status redirect) there is no
shell at all; just delete the directive.

---

## 3. Open question: PPR viability on Next 16.2.2 + self-hosted (non-Vercel)

**Verified facts:**
- `apps/console/package.json` → `"next": "^16.2.2"`.
- `apps/console/next.config.mjs` → `output: 'standalone'`, `outputFileTracingRoot` set,
  **no `experimental.ppr` key**. Deploy is the Docker reference-server image, not Vercel.

**Open question for Codex:** Do we turn on PPR (`experimental: { ppr: 'incremental' }`) or rely
on the plain static-shell-+-Suspense behavior?

- **PPR's value-add** is serving a *prerendered static shell* immediately and streaming the
  dynamic holes from the same response — best perceived performance.
- **Without PPR**, the same component shape still works: a route with no top-level dynamic read
  + `Suspense` holes that fetch is a normal streaming RSC route. The shell can be statically
  generated; the holes stream. We do **not** need PPR for the safe set to remove `force-dynamic`
  and stop the repeated-fetch stacking — we need PPR for the *fully prerendered-shell* upgrade.
- **Self-host caveat:** PPR + `output: 'standalone'` should function (PPR is build-time
  prerender + runtime stream, no Vercel-only infra), but this is **unverified on our image** and
  PPR is still flagged `experimental`. Enabling a global experimental flag is a blast-radius
  decision for the whole console, so it is a separate owner call.

**Recommendation / fallback:** Ship the safe set as **plain static-shell + Suspense (no PPR
flag)** first. This is the conservative path: it removes the offending directive, splits the
dynamic read into a hole, and is fully supported on 16.2.2 standalone today. **If** we later want
the prerendered-shell win, enabling `experimental.ppr: 'incremental'` and opting individual
routes in via `export const experimental_ppr = true` is an additive follow-up — *incremental*
mode means only opted-in routes change, minimizing blast radius. If PPR proves unviable on the
standalone image, the static-shell + Suspense version still stands and the fallback below applies.

**If neither PPR nor a static shell is acceptable for a given page** (e.g. a page that's mostly
dynamic but has one expensive cacheable fetch): the fallback is **per-segment caching + targeted
revalidate** — wrap the cacheable fetch in `unstable_cache`/`"use cache"` with a tag, keep the
rest dynamic, and `revalidateTag()` from the mutating server action (the same pattern
`connect/page.tsx`'s `revalidatePath` already uses). This gives most of the win without
restructuring the layout. Note for the record so we don't reach for `force-dynamic` again.

---

## 4. Recommended rollout

**Principle: prove the mechanism on the worst offender with a measurement, then expand to the
verified-safe set, and leave the must-stay-dynamic pages alone.**

1. **Pilot — `runs/page.tsx` (the proven 7–12s offender).** This page is on the *keep-dynamic*
   list (live `LivePoller`), so we do **not** remove its directive. Instead, pilot the
   *measurement + the hole-splitting mechanism* here, because it's where the pain is provable:
   - Capture a **before** trace with the browser harness (`/home/user/.tmp/ink-carbon-shots/capture.mjs`
     pattern, or a fresh Playwright run against `https://pdpp.vivid.fish/dashboard/runs`):
     record RSC request count + total load time (the 2–5 repeated fetches, 7–12s).
   - Apply the *child-fetch split* (move `listRuns`/`listConnectorSummaries` into a `Suspense`
     child; keep `LivePoller` mounted in the shell driven by data the child passes up via the
     poll, **not** a cached value) — and/or de-dupe the repeated fetch with React `cache()`,
     which is the likely direct cause of the *repeated* (not just slow) fetches.
   - Capture **after**. The acceptance bar: RSC fetch count drops to 1 per render and load time
     falls out of the 7–12s band. This validates the mechanism before touching cacheability.

2. **Safe set — pages 1, 2, 3.** Apply §2 pattern, remove the directives. Add/extend
   `route-loading.invariants.test.ts`-style assertions that (a) the route no longer exports
   `dynamic = "force-dynamic"`, (b) the page function does not `await searchParams` at top level,
   (c) the dynamic children are `Suspense`-wrapped. Re-run the harness on `/dashboard/traces` for
   a before/after.

3. **Measure each safe page** before/after with the same harness (fetch count + TTFB/load). Land
   one page per PR so a regression is bisectable.

4. **Leave must-stay-dynamic pages alone** (the DO-NOT list below). Re-examine the two
   lower-confidence keeps (pages 16 `static-secret/[connectorId]` and any "self-inflicted" label
   that survived as a keep) in a *separate later wave* with their own verification — do not fold
   them into this wave.

---

## 5. DO NOT (must-stay-dynamic — do not make cacheable in this wave)

These remain `force-dynamic`. Each has a verified live-data, mutation, freshness, or security
reason in §1. Do not touch their directives:

- `dashboard/runs/page.tsx` — live `LivePoller` enable/disable + `?peek` pre-render redirect.
- `dashboard/records/page.tsx` — `runningCount` drives poll cadence (behavioral contract).
- `dashboard/records/[connector]/page.tsx` — live `last_run.status` → "Active run" header.
- `dashboard/records/[connector]/[stream]/page.tsx` — live count + column enumeration in shell.
- `dashboard/records/[connector]/[stream]/[recordKey]/page.tsx` — owner-scoped record payload.
- `dashboard/records/[connector]/[stream]/health/page.tsx` — `no-store` live diagnostics.
- `dashboard/records/add/page.tsx` — live connection counts in shell body copy.
- `dashboard/stream-playground/page.tsx` — lazy-create session **mutation**, operator-scoped.
- `dashboard/traces/[traceId]/page.tsx` — entire surface is cursor-dependent.
- `dashboard/connect/page.tsx` — identity list must reflect post-`revalidatePath` state.
- `dashboard/connect/status/[connectionId]/page.tsx` — live operation-progress shell.
- `connect/browser-session/[connectorId]/launch/page.tsx` — ephemeral per-request `connection_id`.
- `connect/static-secret/[connectorId]/page.tsx` — post-mutation redirect params (lower-conf; later wave, still keep now).
- `connect/manual-upload/[connectorId]/page.tsx` — `no-store` connector metadata in shell.
- `dashboard/search/page.tsx` — live run status + query redirect + auth-isolation gap.
- `dashboard/grants/request/page.tsx` — **cross-user leak**: unbound `globalThis` workspace.
- *(plus every page not yet individually verified — default keep.)*

---

## 6. One-line summary for the PR description

> Restore the three verifier-cleared pages (`traces`, `connect/browser-session/[connectorId]`,
> `connect/static-secret/.../status/...`) to cacheable static-shell + `Suspense`-child shape
> (searchParams read inside the hole, auth stays in the no-store fetcher). Pilot the
> fetch-de-dup measurement on the proven `runs` offender first. Leave all live-poll / mutation /
> owner-scoped / cross-user pages on `force-dynamic`. PPR flag is a separate additive decision;
> the static-shell shape works on 16.2.2 standalone without it.
