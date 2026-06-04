# Connector Progress Ledger Deferral

Status: decided-defer
Owner: RI owner
Created: 2026-06-04
Updated: 2026-06-04
Related: openspec/changes/add-connector-adaptive-lanes

## Question

Should the reference implementation add a durable, connector-agnostic progress ledger now, or use the current connector progress system for the immediate ChatGPT rate-limit/resume work?

## Context

The current connector runtime already exposes progress reporting, and the operator surfaces already summarize connection health through connector-agnostic axes such as coverage, freshness, attention, and outbox. ChatGPT now has evidence that large histories can trigger source-side throttling, so owner-facing progress must be honest about partial hydration, retryable gaps, and scheduled resume.

## Stakes

A durable per-unit progress ledger could make backlog and retry state more precise across restarts, but it would add storage shape, dashboard semantics, and connector contract surface before the immediate ChatGPT safety problem requires it. The near-term risk is letting a broader abstraction delay the account-safe connector behavior.

## Current Leaning

Defer the generic durable ledger. Use the current progress channel and existing connector state to make ChatGPT safe now:

- Emit clear progress messages with counts, totals, retryable failures, and throttle reason.
- Persist enough connector state to resume without redoing completed work.
- Stop early on a small 429 budget and schedule/resume later instead of hammering the source.
- Let existing connection health continue to show incomplete coverage and retryable/freshness state.

This preserves most near-term owner value without committing to a general ledger shape prematurely.

## Promotion Trigger

Promote to OpenSpec if two or more connectors need durable per-unit backlog accounting that cannot be represented with existing progress events, connector state, and connection health axes.

## Decision Log

- 2026-06-04: Deferred a generic durable ledger so ChatGPT can move forward using the current progress system plus safe resume/backoff.
