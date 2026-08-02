# Repair terminal evidence residual

## Why

A connection can retain a dirty summary-evidence envelope across a process
restart even when its durable record, manifest, and terminal facts are enough
to repair it. The periodic maintenance timer previously waited one full
interval before its first pass. Owner reads correctly rendered that unresolved
state as not measured, but a settled-looking forward statement could remain
alongside it.

## What changes

- Launch the existing bounded, fenced startup walker synchronously before the
  periodic connector-maintenance timer is armed, making it the explicit
  first-pass authority.
- Preserve the timer's ordinary periodic cadence without giving it a
  competing immediate boot tick.
- Keep ordinary owner reads read-only and preserve the periodic cadence.

## Impact

The change affects reference connector-summary maintenance only. It does not
infer coverage, change unknown classifications, modify connector-specific
collection behavior, or add writes to owner reads.
