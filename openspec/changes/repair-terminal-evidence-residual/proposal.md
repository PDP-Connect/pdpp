# Repair terminal evidence residual

## Why

A connection can retain a dirty summary-evidence envelope across a process
restart even when its durable record, manifest, and terminal facts are enough
to repair it. The periodic maintenance timer previously waited one full
interval before its first pass. Owner reads correctly rendered that unresolved
state as not measured, but a settled-looking forward statement could remain
alongside it.

## What changes

- Run the existing bounded, fenced connector-maintenance sweep once when its
  timer is armed.
- Keep ordinary owner reads read-only and preserve the periodic cadence.

## Impact

The change affects reference connector-summary maintenance only. It does not
infer coverage, change unknown classifications, or modify connector-specific
collection behavior.
