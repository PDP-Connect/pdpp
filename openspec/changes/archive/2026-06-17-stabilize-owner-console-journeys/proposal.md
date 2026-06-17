# Stabilize Owner Console Journeys

## Why

The live owner console failed a real owner walkthrough. The specific defects were not isolated copy mistakes: they showed that worker lanes were shipping local improvements without proving the owner journey. The console must make a motivated personal-server owner feel: "I know what data I have, I know how to add more, I know what is broken, I know what to do next, and I trust this system."

## What Changes

- Define the owner-console journey contracts for Sources, Add data, browser-session setup, recovery, and Inspect data.
- Make unavailable setup paths, unknown states, attention, recovery actions, and source-row geometry explicit durable requirements.
- Require headed journey evidence, screenshots, console/network capture, and live-stack mutex closeout before deploying owner-console UI changes.
- Establish a worker discipline: workers gather evidence or implement bounded owner-authored packets; they do not decide shippability.

## Capabilities

Modified:

- `reference-surface-topology`
- `reference-implementation-governance`

## Impact

This change governs the console recovery work after the failed journey batch. It does not change PDPP Core protocol semantics. It does change the reference owner-console bar for what can ship: unit tests and route-local screenshots are necessary but not sufficient.
