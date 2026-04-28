# Reddit Gilded Stream Retraction

Status: decided-defer
Owner: owner
Created: 2026-04-28
Updated: 2026-04-28
Related: openspec/changes/add-polyfill-layer-two-stream-coverage

## Question

Should the Reddit connector continue to declare and fetch a `gilded` stream?

## Context

A live owner-authenticated Reddit run failed after successfully flushing records from the other Reddit streams. The terminal error came from fetching `/user/{username}/gilded.json`.

An audit compared the listing endpoints currently used by the connector:

- `submitted` and `comments` are public-readable JSON listings.
- `saved`, `upvoted`, `downvoted`, and `hidden` behave like owner-only listings: unauthenticated probes return authorization failures rather than route-not-found failures.
- `gilded` does not follow the owner-only pattern. The old Reddit host returns not found, and the current web/OAuth hosts redirect to the profile page instead of serving a JSON listing.

The same run surfaced two `subreddit: invalid subreddit name` shape skips. Those records belonged to Reddit's archived legacy `reddit.com` subreddit, which still appears in old listing data even though it violates the modern subreddit-name regex.

## Stakes

Keeping `gilded` declared would make the connector fail after collecting valid owner data and would advertise a stream that does not have a current verified collection surface. Silently skipping the endpoint would be worse: it would preserve a misleading manifest contract and turn an unsupported stream into hidden partial coverage.

Rejecting `reddit.com` as a subreddit would also drop real historical owner records for an implementation-detail reason.

## Current Leaning

Retract `gilded` from the shipped Reddit stream contract until a real current endpoint is found and verified with live evidence.

Keep the other six streams. They have distinct live behavior from `gilded`, and their authentication failures are consistent with expected owner-only Reddit listing surfaces.

Accept `reddit.com` explicitly in the local Reddit schema as a grandfathered archived subreddit, while keeping the modern subreddit-name constraint for all other values.

## Promotion Trigger

Promote a follow-up before reintroducing a gilded/awards stream. The follow-up must name the current endpoint, prove the response shape with live evidence, update the manifest and schemas, and include connector tests that fail if the endpoint disappears.

## Decision Log

- 2026-04-28: Owner live run failed on `gilded` after flushing valid records from the other streams.
- 2026-04-28: Audit found `gilded` behaves as a dead/redirected route, not as an owner-only route.
- 2026-04-28: Decision: retract `gilded` and preserve the evidence in this change-local note.
- 2026-04-28: Decision: accept legacy `reddit.com` subreddit values so old real records do not become schema skips.
