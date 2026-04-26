# Client Event Subscriptions And Freshness

Status: captured
Owner: protocol / reference query API
Created: 2026-04-26
Updated: 2026-04-26
Related: changes_since, freshness metadata, webhook/push delivery profile research, client grants

## Question

Should PDPP support client subscriptions/webhooks for events that are allowed by the client's grant scope, and should clients be able to inspect data freshness or request a refresh without any guarantee that fresher data will become available?

## Context

`changes_since` gives clients an efficient pull cursor, but it still requires polling. Some data sources update only daily or weekly, while other clients may want to react quickly when new grant-visible records arrive. Frequent polling is wasteful when upstream collection is slow, scheduled, or manually gated.

Existing repo research mostly treats platform-to-server webhooks and push delivery as runtime/collection concerns. This note is about the other direction: personal server to authorized client notifications, scoped by the client's grants.

## Stakes

- A client event subscription must not leak the existence of records or fields outside the client's grant projection.
- Notification payloads may need to be minimal, with the client using normal RS queries or `changes_since` to fetch authorized records.
- Freshness metadata must stay honest: the RS can report when it last observed or collected data, but it cannot guarantee upstream freshness for non-cooperating platforms.
- A "request refresh" affordance may be useful, but it must be best-effort and may require owner interaction, connector scheduling policy, or upstream rate-limit/bot-detection constraints.

## Current Leaning

Do not design this as a quick endpoint. First run prior-art research across Plaid-style webhooks, Stripe event destinations, GitHub webhooks, Google/PubSub watch channels, Microsoft Graph change notifications, Slack Events API, WebSub, CloudEvents, ActivityPub/inbox models, MCP/resource notifications if relevant, and existing PDPP `changes_since` / freshness semantics.

Likely shape to investigate:

- subscription creation is authorized by the same grant/client model as reads
- server sends coarse events such as `records.changed`, `grant.revoked`, or `freshness.changed`
- event payloads are projection-safe and probably carry cursors or stream hints rather than full records by default
- clients fetch changes with `changes_since`
- refresh requests are advisory best-effort operations with typed refusal/queued/interaction-required outcomes

## Promotion Trigger

Promote to OpenSpec before adding any client-facing subscription endpoint, webhook signing contract, event payload shape, freshness guarantee language, or client-triggered refresh API.

## Decision Log

- 2026-04-26: Captured from owner request. Needs deep prior-art research before spec language.
