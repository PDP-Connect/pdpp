## Why

n.eko exposes only XRandR configurations that exist in its X server. The reference image does not expose the 915x412 landscape twin, so viewport-driven selection cannot choose the phone shape after rotation.

## What Changes

- Add 915x412 alongside the existing 412x915 Xorg mode in the shared n.eko image.
- Derive Chromium's launch window from the active n.eko screen unless an operator explicitly overrides it.
- Add deterministic configuration-list and cover-fit selection regression tests.

## Capabilities

- Modified: `reference-implementation-architecture`

## Impact

Static n.eko and dynamically allocated n.eko containers use the same image and expose CSS-sized, DPR-1 phone modes for stream selection.
