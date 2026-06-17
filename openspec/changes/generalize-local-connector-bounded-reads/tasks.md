## 1. Contract

- [ ] Add the filesystem/local-DB bounded-read requirement to `local-agent-collector-completeness`.
- [ ] Add a manifest- or registry-driven regression guard for local connector whole-file and unbounded `.all()` reads.
- [ ] Add reviewed exceptions for small per-artifact reads with explicit reasons.

## 2. High-Risk Connectors

- [x] Convert `imessage` local database reads from unbounded `.all()` to row iteration.
- [ ] Convert `twitter_archive` archive parsing away from whole-file array materialization, or stop with a documented design blocker if a safe streaming parser is not feasible in this tranche.
- [ ] Convert large Slack dump row reads to row iteration or document bounded query exceptions.

## 3. Validation

- [ ] Run targeted polyfill connector tests for changed connectors.
- [ ] Run `pnpm --filter @pdpp/polyfill-connectors typecheck`.
- [ ] Run `openspec validate generalize-local-connector-bounded-reads --strict`.
