## Context

Amazon collection is a list+detail connector. The list page provides the order denominator, while each detail page enriches `order_items`. Existing `DETAIL_GAP` and `DETAIL_COVERAGE` behavior already keeps coverage honest, but the detail lane has two gaps:

- failed detail pages are not captured unless a later detail succeeds;
- every failed order can spend the full retry and wait budget, even when the run is seeing the same temporary failure repeatedly.

The fix stays inside the Amazon connector. It does not change the global run watchdog or the runtime's checkpoint contract.

## Design

`fetchOrderDetail` should return a structured result instead of only `OrderDetail | null`. The result carries:

- `status`: hydrated, failed, or deferred;
- `reason`: a redacted reason code suitable for `DETAIL_GAP.reason`;
- `detail`: parsed detail only on hydration.

On a failed attempted detail fetch, the connector captures the current page once per run when fixture capture is enabled. This gives parser/debug evidence for the failed page shape without expanding fixture capture to every order.

The run keeps a per-run count of repeated retryable temporary failures. Once the threshold is reached, later order details in the same run are deferred immediately as retryable `DETAIL_GAP` records. List-page order and item records still emit. `DETAIL_COVERAGE` still lists those order ids as required and gap keys, so the run does not look complete.

## Alternatives

- Increasing the global watchdog was rejected. It would hide the connector-specific failure mode and make other connectors less bounded.
- Treating failed details as terminal was rejected. Existing failures can be transient Amazon behavior, redirects, slow pages, or layout drift; a retryable gap is the honest default unless a later fixture proves terminal behavior.
- Capturing every failed detail page was rejected. One failed-detail fixture per run is enough to debug the page class while keeping raw capture bounded.

## Acceptance checks

- OpenSpec validates strictly.
- Focused Amazon tests prove reason classification, failed fixture capture, and deferral after repeated temporary failures.
- Typecheck is attempted for the polyfill connector package if local dependencies permit.

## Residual risks

- The threshold is connector-local and heuristic. A live Amazon run may justify tuning after comparing elapsed time and captured failed page fixtures.
- Raw failed-detail fixtures may contain owner data. They are written only through existing `PDPP_CAPTURE_FIXTURES` / `PDPP_CAPTURE_ON_FAILURE` opt-ins under the gitignored raw fixture tree.
