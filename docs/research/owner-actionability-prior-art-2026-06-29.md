---
title: "Owner actionability surfaces: prior-art notes"
date: 2026-06-29
status: captured
scope: reference owner console source-health/actionability design
---

# Owner actionability surfaces: prior-art notes

## Question

How should the reference owner console present source problems when the underlying system has multiple internal states: health, freshness, coverage, retryability, owner attention, maintainer work, and passive checking?

## Sources

- Stripe, "Payment status updates", accessed 2026-06-29: https://docs.stripe.com/payments/payment-intents/verifying-status
- Datadog, "Monitor Status Page", accessed 2026-06-29: https://docs.datadoghq.com/monitors/status/status_page/
- Plaid, "Link - Update mode", accessed 2026-06-29: https://plaid.com/docs/link/update-mode/
- Sentry, "Issue Status", accessed 2026-06-29: https://docs.sentry.io/product/issues/states-triage/

## Findings

1. Actionability is not the same as status. Stripe maps detailed PaymentIntent lifecycle states into Dashboard payment statuses, but still exposes an explicit `next_action` when an integration must do more work. The lesson for PDPP: the console should not force the owner to infer actionability from health labels such as `Degraded` or `Checking`.

2. User repair should be named as a flow, not as an internal condition. Plaid treats broken Items as update-mode work: when access stops working, the user is sent through a focused repair flow and the system can dismiss messaging when repair happens elsewhere. The lesson for PDPP: reauth/local-collector recovery should be a focused owner task, not an ambiguous row in a generic failure bucket.

3. Investigation context and action controls belong together but should remain scoped. Datadog's monitor status page uses the alert as the entry point, then presents context and quick actions to move the incident toward resolution. The lesson for PDPP: rows should link to the exact connection detail/recovery surface and avoid connector-wide or sibling evidence.

4. Automatic state and triage buckets are distinct. Sentry issue status can be assigned automatically, while triage tabs such as unresolved/for-review shape what the user sees first. The lesson for PDPP: `rendered_verdict.channel` can remain the authoritative machine agency signal, while the owner console projects it into a smaller set of task groups.

## Design implications for PDPP

- Keep the server-owned `rendered_verdict` as the source of truth for tone, channel, and required actions.
- Add one owner-console projection that answers: "What requires the owner?", "What is worth reviewing?", "What is a system/maintainer issue?", and "What is only being checked?"
- Do not show owners internal taxonomy labels such as `attention`, `advisory`, `terminal_gap`, or `outbox`.
- Counts must match the visible scope. A hero that says "3 need you" must count only rows under "Needs you"; if the panel also shows review/system/checking rows, those rows need their own headings or counts.
- Rows must not duplicate the same connection across task groups. A connection's strongest owner-facing task owns the row; lower-priority facts remain on the connection detail surface.
