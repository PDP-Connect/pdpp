## Decision

`DETAIL_COVERAGE.state_stream` identifies the cursor whose boundary supplied
the reported detail keys. A detail stream may therefore appear more than once
per run when disjoint parent cursors feed it. The runtime stores each report
under its declared parent and withholds only parents whose required keys are
unaccounted.

The existing `optional_skip_keys` field remains the accepted-absence channel.
It is not a generic error bucket. A connector may place a key there only when:

1. the stream contract makes the detail optional while retaining an honest
   metadata record;
2. a provider-specific parser positively identifies the provider's terminal
   object-unavailable response; and
3. redirects, transport faults, throttles, server errors, generic access
   denials, validation failures, and upload failures remain uncovered.

For GroupMe, an unavailable blob requires the exact allowlisted GroupMe CDN,
the expected bounded S3 XML error envelope, and an accepted terminal error
code. A bare 403 or 404 is not enough. The attachment metadata record retains
`hydration_status: unavailable`; no blob reference is fabricated.

The parser does not rely on `Content-Length`: the live GroupMe CDN omits that
header on its XML errors. It streams through the same hard byte cap used for
blob validation and accepts exactly one recognized code inside a complete
`Error` envelope.

## Evidence

- GroupMe's official Image Service documentation, checked 2026-08-13, defines
  `i.groupme.com/{width}x{height}.{format}.{id}` as the public URL returned for
  uploaded message images and documents the `large`, `preview`, and `avatar`
  variants: https://dev.groupme.com/docs/image_service
- On 2026-08-13, 20 retained UAT attachment URLs returned bounded S3 XML
  `AccessDenied` responses from that exact public host while 10 retained
  hydrated URLs fetched concurrently from the same host returned 200. Ten
  denied objects also remained denied under every officially documented
  thumbnail suffix. This discriminates object-level provider unavailability
  from a deployment-wide network or authentication failure.

## Rejected Alternatives

- Binding all attachment coverage to `attachments`: this cursor deduplicates
  emitted records but does not enumerate source messages, so advancing a
  parent cursor can strand a failed attachment.
- Treating every 403/404 as unavailable: access control, WAFs, and temporary
  policy can use the same statuses.
- Adding connector-specific behavior to the reference implementation: parent
  fan-in and coverage accounting are protocol facts and remain provider
  neutral.
- Persisting a GroupMe CDN URL as a retry locator: durable-gap metadata
  intentionally redacts URL paths and queries. Bypassing that boundary would
  retain sensitive provider identifiers without a general encrypted-locator
  contract. GroupMe instead leaves the key uncovered so the owning parent is
  re-enumerated.
- Adding a second unavailable-key wire field: the existing optional-skip
  channel already represents accepted item-level absence once its evidence
  threshold is specified.

## Acceptance

- A two-parent detail stream independently commits or withholds each parent.
- A durable gap is matched by detail stream, record key, and parent; a key
  collision across parents cannot authorize the wrong checkpoint. Legacy
  parentless gaps remain valid only for single-parent detail streams.
- A transient GroupMe attachment failure prevents its parent checkpoint from
  advancing and is retried on the next run.
- A staged manifest parent that omits its coverage report cannot commit.
- A synthetic status-only 403/404 remains uncovered.
- A bounded, exact GroupMe CDN terminal XML response is retained as
  unavailable and accounted without a fabricated blob.

## Residual Risk

After implementation acceptance, deploy the exact candidate SHA and observe a
live GroupMe run plus the rendered source-health projection. That deployment
check is release acceptance, not an implementation task in this change.
