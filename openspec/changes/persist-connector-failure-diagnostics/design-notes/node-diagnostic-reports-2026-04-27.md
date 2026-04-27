# Node Diagnostic Reports For Connector Crashes

Status: decided-promote
Owner: reference-runtime
Created: 2026-04-27
Updated: 2026-04-27
Related: openspec/changes/persist-connector-failure-diagnostics, tmp/connector-failure-diagnostics-followup-node-reports.md

## Question

Should Node.js diagnostic reports be part of the connector-failure diagnostics answer?

## Context

Node diagnostic reports can capture fatal V8/native errors and uncaught exceptions in Node connector children. They cover failures where a connector may not write useful stderr, but they do not cover every deliberate `process.exit(1)` path and they are Node-specific.

Connector children inherit `NODE_OPTIONS` from the reference runtime environment. If report flags are set without exclusions, reports can include `environmentVariables` and `networkInterfaces`. Connector env often contains API tokens, cookies, usernames, passwords, and local filesystem paths.

## Stakes

The reports are useful for operator forensics, but the default report contents are too sensitive to enable casually in a connector-inheritable process.

## Current Leaning

Use Node reports as a complementary, operator-local diagnostic artifact. Do not replace stderr-tail persistence with reports. If report flags are enabled in dev/runtime commands, include `--report-exclude-env` and `--report-exclude-network`.

Do not link reports from run timelines until per-run correlation, retention, and authorization have been designed.

## Promotion Trigger

Triggered because the repo already had partial dev-script report enablement and connector children may inherit those flags.

## Decision Log

- 2026-04-27: Promoted into `openspec/changes/persist-connector-failure-diagnostics`.
- 2026-04-27: Owner decision is "reports are complementary and secret-minimized when enabled; no run-linked report artifact yet."
