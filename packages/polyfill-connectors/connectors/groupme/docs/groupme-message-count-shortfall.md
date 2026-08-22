# GroupMe: why some groups stop short of the provider's message count

**Verdict: the earlier claim that GroupMe "contradicted itself" was WRONG and has been retracted.**

A prior revision emitted the reason code
`provider_served_empty_page_against_its_own_count`, asserting that GroupMe
reported a message count and then served an empty page *for that count* —
i.e. that the API contradicted itself in a single response body. That claim
was never verified. This note records the evidence that refutes it, and what
the observation actually means.

The reason code is now `history_ended_before_provider_count`, which
describes what we observed rather than what we concluded about the provider.

## 1. What `count` actually means

`count` is **undocumented**. GroupMe's API reference (dev.groupme.com/docs/v3)
shows it only inside the sample body for `GET /groups/:id/messages` and never
defines it in prose. Every available signal says it is the conversation's
**lifetime total**, not the size of the page just served:

- `GET /groups` returns the same key as `messages.count`, sitting beside
  `last_message_id` — self-evidently a group total.
- A per-page reading would make `count` always equal `messages.length`, so the
  field would carry no information at all.
- Groupy, the most widely used Python wrapper, binds `count` to a field named
  `message_count` and returns it from `__len__` — i.e. "how many messages this
  group has". It re-reads it on every page because the total can drift upward
  while paginating.
- No mature client terminates pagination on a `count` comparison. Groupy,
  `cdzombak/groupme-tools`, and others all terminate on HTTP 304, an empty
  array, or a short page.

**Therefore an empty page against a non-zero `count` is not a contradiction.**
The two fields answer different questions: "how many messages has this group
ever held" versus "what can I serve you from this cursor". A total that
exceeds what pagination can reach is an ordinary, expected state.

Note also that the two counts in our own code come from **different
endpoints** and must not be conflated: `pageEndedShortOfProviderCount` reads
the per-response `count` from `GET /groups/:id/messages`, while the shortfall
arithmetic uses `providerMessageCount()` from the `/groups` listing.

## 2. The documented terminal page cannot produce a false positive

GroupMe documents: *"If no messages are found (e.g. when filtering with
`before_id`) we return code 304."* Our `fetchMessagesPage` normalizes that 304
into a synthetic `{count: 0, messages: []}`. Because the synthetic count is
zero, `pageEndedShortOfProviderCount` returns `false`, so the documented
end-of-history signal never trips the shortfall path. The path can only be
reached by a genuine HTTP 200 carrying a real non-zero `count`.

## 3. What is actually happening: a retention cliff at Aug 2013

Measured against this owner's live Postgres (connector instance
`cin_5804a2ff36cd303e22762745`, 88,743 stored `group_messages` across 156
groups):

| bucket | groups | meaning |
|---|---|---|
| fully reconciled | 77 | stored count >= provider total |
| partial | 36 | some messages stored, fewer than the total |
| zero stored, non-zero total | 42 | nothing stored at all |

Grouping the 156 groups by the year of their last activity (`updated_at`)
makes the cause unmistakable:

| last active | groups | zero stored | has messages |
|---|---|---|---|
| 2011 | 1 | 1 | 0 |
| 2012 | 31 | 31 | 0 |
| 2013 | 12 | 10 | 2 |
| 2014 | 13 | 0 | 13 |
| 2015 | 20 | 1 | 19 |
| 2016–2024 | 79 | 0 | 79 |

Every group that went dormant in 2011–2012 stored **zero** messages. Every
group active from 2014 onward stored messages. This is a temporal cliff, not
the scattered, load-correlated pattern throttling would produce.

The cliff has an exact date. **The oldest stored message anywhere in this
account is `2013-08-15T18:08:31.000Z`.** And of the 36 partial groups, all 36
have their oldest surviving message on or after that date — zero exceptions.
A group's history is retrievable back to roughly Aug 2013 and no further,
regardless of which group it is.

Independent corroboration: GroupMe's own API support forum carries a user
report of paginating `before_id` to a 304 and reaching only ~62k of a reported
70k messages, with *"Last message it returns is from Aug 2013."* Same wall,
same date, a different account. The working explanation there was likewise
server-side retention.

## 4. Scope, and whether the data is recoverable

The production run (`run_1787350099426`, evidence as of
`2026-08-21T22:11:56Z`) reported **1,601 messages across 42 groups**. Those
42 groups are exactly the zero-stored set above; all show `walked: 0`.

Independent reconciliation of stored records against the persisted `/groups`
totals gives a **total shortfall of 6,982 messages across 78 groups** — the
1,601 figure covers only the 42 zero-stored groups, not the 36 partial ones.
The affected messages are all pre-Aug-2013.

**Is the owner's data missing?** These messages were never collected, because
GroupMe would not serve them. They are not lost *by PDPP* — nothing was
collected and then dropped. Everything GroupMe did serve is stored.

**Is it recoverable?** Almost certainly not through this API. Retrying will
not help if the messages are no longer stored on GroupMe's side, and the
evidence strongly indicates that. We nevertheless keep the gap `retryable`
rather than asserting `not_retriable`, because a single response cannot
distinguish retention from a transient refusal *per group*, and asserting
unrecoverability would repeat the original error of converting an ambiguous
observation into a certain verdict.

## 5. What could not be verified

- **No live API call was made.** The stored credential is sealed, and
  unsealing owner secrets was out of scope. A single live request against one
  affected group (e.g. `4747691`, provider count 1, zero stored) would
  directly confirm the response shape; this note rests on stored artifacts and
  documentation instead.
- **No captured raw API response exists.** `/root/.pdpp/fixture-captures/`
  in `pdpp-core-prod-drain` has no `groupme` directory, so the primary
  artifact — a recorded body showing `count: N` with `messages: []` — was
  never captured. The emitted `known_gaps` diagnostics in `spine_events` are
  the closest available evidence, and they record only our derived
  per-group `provider_count`/`walked` pairs, not the raw page.
- **GroupMe's server-side intent for `count` is not provable** from primary
  sources, because the field is undocumented. The conclusion rests on
  convergent circumstantial evidence (see §1), which is strong but not
  certain.
