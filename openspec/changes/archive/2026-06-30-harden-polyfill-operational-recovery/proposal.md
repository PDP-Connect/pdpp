## Why

Live browser-backed recovery exposed two operational failure modes that were misclassified or blocked local repair:

- USAA returned a source-unavailable login modal, but the connector reported selector drift.
- Local dependency installation failed on Ubuntu 26.04 because Patchright does not publish Chromium for that platform.

## What Changes

- Classify known source-unavailable login page states separately from connector selector-shape failures.
- Treat that USAA source-unavailable class as retryable runtime evidence.
- Skip Patchright's optional Chromium download on known unsupported local platforms unless strict browser-download proof is requested.

## Capabilities

Modified:

- `polyfill-runtime`

## Impact

- Improves owner-facing diagnostics and scheduler retry behavior for transient USAA login outages.
- Lets local dependency repair complete on unsupported Patchright browser-download hosts without changing browser launch posture in runtime environments.
