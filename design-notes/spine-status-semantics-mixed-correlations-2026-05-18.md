# Spine Status Semantics For Mixed Correlations

Status: captured
Owner: reference implementation owner
Created: 2026-05-18
Updated: 2026-05-18
Related: `reference-implementation-architecture`; disclosure spine status projection; run interaction streaming companion

## Question

How should spine consumers distinguish a run's lifecycle status from sub-resource statuses emitted on the same run correlation?

## Context

The spine event model currently stores a generic `status` column for both run lifecycle events and sub-resource events. A run can fail while a related sub-resource event, such as stream-session resolution, carries `status: "completed"`. A naive latest-status summary can therefore display a failed run as completed.

A targeted reference patch prefers known run-terminal event types when summarizing run correlations, but that is a hardcoded safeguard rather than a durable model.

## Stakes

Run status must be honest for dashboard, CLI, and third-party readers. If consumers infer terminal status from unqualified status strings, future sub-resource events can reintroduce false success or false failure.

## Current Leaning

The cleanest likely direction is an explicit run-terminal event marker or normative terminal event table. Status namespacing and separate spines remain alternatives, but they carry more migration and consumer complexity.

## Promotion Trigger

Promote this to OpenSpec before changing spine schema, event type contracts, correlation summary APIs, or dashboard/CLI status semantics beyond narrow reference-only patches.

## Decision Log

- 2026-05-18: Moved from invalid no-delta OpenSpec change `refine-spine-status-semantics-for-mixed-correlations` into design notes because this is an unresolved design question, not an implementable change.
