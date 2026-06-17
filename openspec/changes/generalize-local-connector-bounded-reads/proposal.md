## Why

The Codex and Claude Code local collectors now avoid whole-file and whole-result-set memory spikes, but the same source-size-to-heap hazard remains in peer filesystem and local-DB connectors. Heavy local exports such as Twitter archives, iMessage `chat.db`, and Slack dump databases can be hundreds of megabytes or larger. A connector-wide contract is needed so bounded memory is not a one-off property of two agent connectors.

## What Changes

- Generalize the local-agent bounded-read rule into a filesystem/local-DB connector rule.
- Add a manifest/source-class guard that detects unbounded whole-file reads and unbounded local SQLite `.all()` materialization unless explicitly justified.
- Convert the highest-risk local connectors to streaming or row-iterating reads, starting with `imessage`, `twitter_archive`, and large Slack dump reads.
- Keep small per-artifact reads allowed only when the connector documents why the artifact is bounded enough for process memory.

## Capabilities

Modified:

- `local-agent-collector-completeness`

## Impact

- Affects `packages/polyfill-connectors` local filesystem and local-DB connectors.
- No protocol or RS API shape changes.
- Expected benefit is lower peak RSS and fewer kernel/OOM failures for large local imports or device-local collector runs.
- Risk is parser behavior drift for archive connectors; mitigated by existing fixtures plus streaming-equivalence tests.
