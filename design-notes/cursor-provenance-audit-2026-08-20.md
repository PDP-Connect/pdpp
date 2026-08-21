# Detecting a cursor a connection never earned

**Status:** deferred. Code removed from the branch; no requirement is proposed yet.
**Date:** 2026-08-20

## What was built, and why it is not in the tree

`reference-implementation/runtime/cursor-provenance.ts` and its test were removed from
`fix/sweep-fairness-and-transformer-bounds` before that PR landed. The module was never wired into
anything: its only reference anywhere in the repo was its own test file, and it does not exist on
`main`. Its own commit (`6af425709`, "detect the three ways a cursor silently excludes data") says
so deliberately — it "stays unwired: it needs the full connection set, so it belongs in the
maintenance sweep rather than the per-run commit."

Unwired, it still failed the zero-connector-knowledge conformance gate, because its watermark table
names eleven connectors in RI production source. That is a real gate finding, not a false positive.
Shipping the module unwired bought nothing and blocked a PR carrying real production fixes, so the
code came out and the analysis stays here.

This note exists so the next person does not rediscover the defect, the ruling, or the blocker.

## The defect: `duplicate_of_sibling`

A watermark cursor ("fetch everything newer than T") is only sound when T was reached by *this*
connection walking its own history. Seed a new connection with another connection's high-water mark
and every record older than T becomes permanently unreachable — the connection will only ever ask
for newer items — while `covered == considered` keeps reporting complete coverage, because the run
genuinely did process everything it fetched.

This is live, not hypothetical. ChatGPT connection `cin_484604984db7c091bd08b259` (created
2026-08-17) held a `conversations` cursor of `2026-06-19T20:30:04.127Z`, byte-identical to the
millisecond to the cursor of a different, paused connection (`cin_e4ab231c7d49b8f59e4c80ed`) that
reached that value on its own final run. Two separate accounts do not independently walk to the same
millisecond. The value was copied, and everything older than it is unreachable for the newer
connection.

The signal is exact equality across sibling connections for the same connector and stream, never
proximity and never staleness. Staleness is explicitly not evidence: an account nobody has posted to
in six months has a legitimately frozen watermark, and firing on it would cry wolf on exactly the
quiet connections an owner is least able to check by hand.

A finding is `suspected`, never a quantified loss. The evidence proves the cursor's *provenance* is
unsound, which makes any completeness claim built on it unfounded; it does not measure how much data
is unreachable. The right outcome is to withhold the healthy claim and tell the owner to re-seed.

One rule was tried and disproved by the live fleet: flagging a cursor that predates its own
connection's `created_at` produced seven false positives across reddit, github, and notion. Those
watermarks store the newest *content item's* timestamp, not an observation time, so a connection
created today that fully walks an account whose newest post is from 2024 correctly stores 2024. The
rule was removed rather than tuned.

## The ruling: this audit stays RI-owned

The architecture owner's decision, which this note records so it is not relitigated: the watermark
specs must NOT move into connector manifests, unlike the sibling `cursor-band-contiguity` check
whose `cursor_shape` enum did move.

Letting a connector declare which of its fields are checkable lets the audited party define the
audit's scope. A connector could omit or mis-path its watermark and silently exempt itself, or
mis-declare `valueKind` (`iso8601` as `epoch_seconds`), making comparisons meaningless with no
error raised. This is an integrity check *about* the connector evaluated *against* the connector,
so the connector cannot be the one who says what counts.

The contrast with `cursor-band-contiguity` is the useful part. There, the manifest declares only a
closed enum (`cursor_shape: "imap_uid_band"`) and the RI owns every semantic — the paths, the
`UIDVALIDITY` epoch guard, the arithmetic. Declaring can only opt a stream *in*; omission yields
silence, never a healthy verdict. That asymmetry is what makes manifest declaration safe there and
unsafe here.

## The blocker: the sibling-JSON route fails both ways

The obvious fix — move `WATERMARK_SPECS` into an RI-owned JSON data file (e.g.
`reference-implementation/data/watermark-specs.json`) and load it at runtime, keeping the data
RI-owned rather than connector-declared — does not work. It was tried and probed empirically against
the real scanner, not just reasoned about. Both halves of rule 5 reject it:

1. **The path.** `SANCTIONED_POLICY_RESOURCES` in
   `reference-implementation/test/helpers/ri-zero-connector-knowledge-data-load-scan.ts` is
   deliberately an empty `Map`. Its own doc records that the two production files which used to load
   a sibling RI-owned registry through it (`compact-record-history.ts`, `version-disposition.ts`)
   were migrated *away* on purpose. A probe file loading such a JSON returns
   `unsanctioned-policy-resource-path`.

2. **The content.** Even with an allowlist entry, `classifySanctionedPolicyResource` parses the
   file and walks it for any string — object key, value, or array element, at any depth — equal to a
   manifest-derived connector key, reporting `hardcoded-connector-literal-in-ri-owned-json`. A
   watermark-spec file is nothing but connector keys, so it fails here even if the path were
   sanctioned.

The scanner states the principle directly, and it is correct: moving a connector-identity fact out
of `.ts` source into a sibling RI-owned JSON file "is exactly as much self-attested connector
knowledge as the literal it replaced, reached via a different seam."

Adding an allowlist entry to get past this would be defeating a gate that is working as designed,
not satisfying it.

## The viable path

Wire the check into the **maintenance sweep**, with the watermark specs supplied by the call site
rather than held as a module-level table in RI production source.

This fits the shape of the check anyway. `evaluateCursorProvenance` needs the full set of
connections for a connector/stream to compare siblings, which is a sweep-time input, not a per-run
one — the reason the original commit left it unwired. Making the specs a parameter means the pure
comparison logic stays RI-owned and connector-agnostic, and the identity table lives wherever the
sweep legitimately assembles per-connector context.

That is a real design task with its own review surface: where the sweep gets the specs, whether a
finding withholds a healthy verdict or only annotates, and how `suspected` is surfaced to an owner
without implying a measured loss. It deserves its own PR rather than being rushed to unblock CI.

Recovering the code: `git show 6af425709 -- reference-implementation/runtime/cursor-provenance.ts`
(and the sibling test path). The module and its 9 tests were passing when removed; only the
conformance gate objected, and only to the identity table.
