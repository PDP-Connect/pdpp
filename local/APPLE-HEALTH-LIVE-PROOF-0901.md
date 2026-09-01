# Apple Health connector — live proof, 2026-09-01

Branch: `waspflow/apple-health-live-proof-0901`, rebased onto
`waspflow/apple-health-fidelity-0901` (`e4072045a`, the entity-regex heart-rate
fix). This session ran the real connector against real downloaded Apple
Health/HealthKit export samples, found and fixed two more real defects, and
scale-tested the streaming design.

## Method

Drove the connector through its **real runtime entrypoint** —
`runConnectorProtocolSubprocess()` (`src/test-harness.ts`), the exact
subprocess protocol an orchestrator uses — against
`connectors/apple_health/index.ts`, with `APPLE_HEALTH_EXPORT_DIR` pointed at
each sample. This is the same mechanism `format-conformance.test.ts` uses;
nothing was hand-called or bypassed.

Samples (downloaded to `~/.tmp/apple-health-samples/`, genuine HealthKit
export structure with the real `<!DOCTYPE HealthData [...]>` DTD):

- `tdda-export6s3sample.xml` — 102 lines, 8.0K, 15 `Record` + 1 `Workout`.
- `dogsheep-export.xml` — 25 lines, 4.0K, 2 `Record` + 1 `Workout` +
  1 `WorkoutRoute`/`Location` pair + 9 `MetadataEntry`, real device-string
  and URL entity escaping.

Both are small — treat this as **structural proof**, not volume proof. Volume
is covered separately by the scale test below.

## Findings against real samples (round 1, before fixes)

**tdda sample**: ran clean. 15/15 records emitted (10 StepCount, 5
DistanceWalkingRunning), 1/1 workout, `gaps=none`.

**dogsheep sample**: ran without crashing, but with two silent defects, found
by inspecting raw output against source XML byte-for-byte:

1. **XML entity decoding was entirely missing from `parseAttrs`.** Every
   attribute value that contained `&lt;`, `&gt;`, `&amp;`, `&quot;`, or
   `&apos;` was emitted verbatim, un-decoded. Concretely: the real HeartRate
   record's `device` attribute
   (`&lt;&lt;HKDevice: 0x282a45810&gt;, name:Apple Watch...&gt;`) was emitted
   as literal `&lt;&lt;HKDevice:...` instead of `<<HKDevice:...`, and the
   Withings-sourced `Withings Link` metadata value
   (`...userid=12345&amp;date=482685932&amp;type=1`) kept its `&amp;`
   un-decoded instead of becoming `&`. This corrupts any device string or
   free-text metadata value containing XML-special characters — exactly the
   kind of real-world content synthetic fixtures don't produce because the
   synthetic generator only *encodes* when writing, and nothing round-tripped
   that back through a real parse. Never caught because no existing test fed
   entity-escaped XML text through `parseAttrs`.
2. **`WorkoutRoute` (nested GPS route data under a `Workout`, itself
   containing `Location` children) matched no branch of the tag scanner and
   vanished with zero trace** — not even counted in the gap tally, unlike an
   unrecognized `Record` type or a missing-startDate drop, both of which were
   already honestly counted. Structurally safe (doesn't corrupt or
   misattribute the parent Workout — the regex simply doesn't match those
   tags, no crash), but a silent gap in the honesty model this connector is
   supposed to maintain. `WorkoutRoute` is common, real content for any
   outdoor workout with location tracking.

## Fixes applied

Both in `connectors/apple_health/parsers.ts` / `types.ts` / `index.ts`:

1. Added `decodeXmlEntities()` — decodes `&lt; &gt; &amp; &quot; &apos;` and
   numeric character references (`&#NN;`, `&#xHH;`) — and apply it in
   `parseAttrs` to every attribute value, the single choke point all
   attribute text passes through. Regression test added:
   `parseAttrs: decodes XML entities in attribute values (real
   device-string / URL shape)` in `parsers.test.ts`.
2. Extended `APPLE_HEALTH_TAG_RE` to recognize `WorkoutRoute` as a countable
   open tag (not a captured element — no schema field represents route
   geometry today), and added `workoutRoutesUncaptured` to
   `AppleHealthGapCounts`, reported in the PROGRESS gap-summary line as
   `workout_routes_uncaptured=N`. Regression test added: `FORMAT-CONFORMANCE:
   WorkoutRoute (GPS geometry) is tallied as an honest gap, not silently
   dropped` in `format-conformance.test.ts`, run through the real subprocess.

**Deliberately not built**: full `WorkoutRoute`/`Location` capture as a new
field or stream. That's a genuine new-feature scope (route points are a
different shape — an array of lat/lon/timestamp/accuracy — not another attr
on the existing Workout row), not a silent-drop fix. Making the gap honest
(counted, visible in PROGRESS) was the proportionate fix for this pass;
capturing route geometry is separate scoped work if wanted later.

## Findings against real samples (round 2, after fixes)

**tdda sample**: unchanged, still clean — 15/15 records, 1/1 workout,
`gaps=none` (no entities or WorkoutRoute content in this sample).

**dogsheep sample**: same record/workout counts (2 records, 1 workout — no
data loss from either bug), now with correct content and honest gaps:

```
device: "<<HKDevice: 0x282a45810>, name:Apple Watch, manufacturer:Apple, model:Watch, hardware:Watch2,4, software:4.3.1>"
metadata["Withings Link"]: "withings-bd2://timeline/measure?userid=12345&date=482685932&type=1"
PROGRESS gaps: workout_routes_uncaptured=1
```

Full test suite: **54/54 pass** (52 pre-existing + 2 new), `tsc --noEmit`
clean, `ultracite check connectors/apple_health/` clean.

## Scale test

The existing `synthetic-export.ts` fixture generator (already used by
`format-conformance.test.ts` at 5k/40k records) was run at **300,000 total
Record elements** (255,035 quantity + 44,965 category, deliberately including
1 unrecognized type and 1 missing-startDate row) across a multi-year span
with multiple sources/devices — an 86MB export.xml, generated to
`~/.tmp/apple-health-live-proof/large/` (disk-backed, not the RAM-backed
`/tmp` tmpfs).

Driven through the same real subprocess protocol with RSS polling
(`peakRssPollIntervalMs: 200`):

| Metric | Result |
|---|---|
| Records emitted | 300,003 / 300,004 (300,003 = 300,004 − 1 deliberate missing-startDate drop) |
| Workouts emitted | 1,500 / 1,500 |
| Wall time | 4.2 s |
| Peak RSS | 147 MB |
| Gap report | `records_dropped_missing_start_date=1 unrecognized_record_types=HKBiomarkerTypeIdentifierFutureBiomarkerNotYetInvented:1` |
| Exit | `DONE status=succeeded` |

147 MB peak RSS on an 86 MB streamed file confirms the streaming design
(constant-ish memory regardless of file size, not a DOM/whole-document load)
holds at ~7.5x the previous largest tested scale (40k records → 300k
records), and gap reporting stayed accurate at scale.

## What is proven vs. not

**Proven**: structural fidelity of the real connector runtime against two
genuine (if small) Apple Health/HealthKit export samples — correct parsing of
`Record`/`Workout`/`MetadataEntry`/`WorkoutEvent`/`WorkoutStatistics`,
correct XML entity decoding, honest gap accounting (unrecognized types,
missing dates, uncaptured route geometry), and a streaming design that holds
bounded memory (147 MB peak) and completes in seconds at 300k records /
1,500 workouts spanning multiple years and sources.

**Not proven**: a real user's full multi-year personal export.xml (typically
tens to hundreds of MB with millions of records from years of continuous
Apple Watch/iPhone sensor data) has not been run. The two real samples used
here are small, third-party-published fixtures (a TDDA test fixture and a
Simon Willison / dogsheep demo file), not a full personal export. Untested
real-world surface that could still exist in a full export and wasn't seen
in these samples: `Correlation` elements (blood-pressure systolic/diastolic
pairs — the DTD in the tdda sample declares this element but the sample
itself contains none), `ActivitySummary` elements (2 present in the dogsheep
sample but neither stream in the manifest maps to them — not a bug, just
unmapped/out-of-scope surface), and non-ASCII/emoji content in free-text
fields beyond the one curly-quote sourceName already seen
("Simon's iPhone").

## Tier-gate status

Connector-code readiness (parsing fidelity, honest gap reporting, streaming
scale) is a **precondition**, not the whole gate. Actual tier promotion is
codified in `src/connector-conformance-roster.ts`: `apple_health` is
currently listed in `REAL_UNLISTED_CONNECTORS` (line ~75), with
`manifests/apple_health.json`'s `capabilities.public_listing.tier` at
`"development"`. That roster's own comment states promotion is a deliberate,
owner-made roster edit ("Promote an entry when its tier becomes Preview or
Supported") gated on live evidence justifying the offer — not an automatic
consequence of the connector code being real. Direct precedent:
`netflix_export` — same import-only shape as apple_health, a real (non-
scaffold) parser — is *still* `development`, confirming "real and tested"
does not auto-promote.

**This proof does not itself flip the tier.** It supplies the live evidence
an owner would use to make that roster+manifest edit. The remaining GDC-demo
blocker identified earlier this session (no product surface/manifest field
lets a user actually hand the connector a real export.xml — confirmed absent
by grep across the repo, not just apple_health's manifest) is separate,
unaddressed by this proof, and orthogonal to connector-code readiness.

## Commit

`e4072045a` (fidelity base) + this session's fix commit, on
`waspflow/apple-health-live-proof-0901`, pushed, no PR opened.
