# External-tool connector adapter prior art

Date: 2026-07-09

## Question

What can a PDPP Collection Profile connector safely delegate to an existing
personal-data command-line tool, and what must remain explicit at the adapter
boundary?

## Primary-source check

The review pinned HPI source revision
[`13685d8`](https://github.com/karlicoss/HPI/tree/13685d8ac432cdeeb09382aa9258cb241eeffeff).
The repository was active when checked, but its modules do not share one
record identity or field vocabulary:

- [`my.reddit.common.RedditBase`](https://github.com/karlicoss/HPI/blob/13685d8ac432cdeeb09382aa9258cb241eeffeff/src/my/reddit/common.py)
  exposes `id` and `text`; it does not establish a generic `body` field.
- [`my.coding.commits.Commit`](https://github.com/karlicoss/HPI/blob/13685d8ac432cdeeb09382aa9258cb241eeffeff/src/my/coding/commits.py)
  exposes `sha` and repository/message/date fields; it does not expose a
  generic `id` field.

An adapter that requires `id` for every module or copies arbitrary upstream
objects into a loose record schema therefore does not prove a conforming HPI
connector. Each mapped module needs an explicit normalization function,
manifest-conformant output, and fixtures pinned to the upstream shape it
claims to support.

HPI remains useful prior art for delegating source parsing and local export
access to an established tool. Repository activity is not evidence that every
module is production-ready, that schemas are uniform, or that mutable source
state is reconciled.

## Boundary conclusions

1. The external-tool process runner may be shared. Source-specific module
   selection, normalization, record identity, cursor choice, and mutable-state
   reconciliation remain connector responsibilities.
2. Runtime mappings must be a closed, manifest-declared set. Arbitrary
   environment-provided module/function names cannot create undeclared streams
   or bypass the consent surface.
3. Output handling must be incremental and bounded. A nominal byte ceiling on
   a fully buffered stdout string is not a streaming design.
4. Cancellation must terminate the complete child process tree and integrate
   with the connector run's cancellation signal. Timeout-only cleanup is not
   sufficient.
5. Malformed output, missing required fields, unsupported modules, and partial
   stream failures need distinct Collection Profile outcomes. Invalid JSONL
   cannot disappear as if it were harmless log output.
6. Mutable streams such as saved-item collections need snapshot or deletion
   reconciliation. An incremental cursor alone cannot prove that removals were
   observed.

## Implication for PDPP

An external-tool adapter is an earned reference-implementation seam, not a new
Core or Collection Profile abstraction. It is worth implementing when a real
connector proves the common process boundary end to end. The adapter should
not land first as a generic framework with no conforming consumer.
