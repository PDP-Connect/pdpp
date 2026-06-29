## Why

A live Amazon run wedged on an order-detail page after navigation succeeded. Browser metadata still responded, but DOM/Runtime CDP calls timed out. The connector's detail path called `page.content()` without an independent timeout, so the run could hang until the controller watchdog instead of recording a retryable detail gap and moving on.

## What Changes

- Add a bounded page-content read helper for browser connector detail/list parsing.
- Use it in the Amazon list and order-detail content reads.
- Add a focused regression proving a renderer that stops answering cannot hang the connector indefinitely.

## Capabilities

Modified:

- `polyfill-runtime`

## Impact

- Prevents one wedged browser page from blocking an entire Amazon run.
- Preserves existing detail-gap semantics; failed detail reads remain retryable and redacted.
- Does not change record schemas or grant-scoped read behavior.
