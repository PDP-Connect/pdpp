## Why

GroupMe attachments can originate from two independently checkpointed parent
streams. The runtime currently rejects more than one `state_stream` parent for
a detail stream, so a connector must either bind coverage to the wrong cursor
or lose retryability after a partial hydration. The same audit also found that
an HTTP status alone is insufficient evidence for treating provider detail as
an accepted optional skip.

## What Changes

- Allow one detail stream to declare separate `DETAIL_COVERAGE` entries for
  distinct parent `state_stream`s in the same run. Each entry gates only its
  own parent checkpoint.
- Permit `optional_skip_keys` for provider detail only when the detail is
  optional in the stream contract and a connector-specific parser
  affirmatively identifies a terminal provider-object response. Status code,
  age, or retry exhaustion alone are insufficient.
- Make GroupMe attachment coverage parent-specific and preserve every
  transient or ambiguous failure as uncovered so the affected parent cursor
  is retried.

## Capabilities

Modified:

- `polyfill-runtime`
- `reference-implementation-runtime`
