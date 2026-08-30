## 1. Shadow contract

- [x] Add the versioned selector schema for changed inputs, protected fallback,
      advertised files, and honored files.
- [x] Add the versioned graph schema for dependency closure, closure bounds,
      truncation, and fallback reasons.
- [x] Add the versioned authority-compatible shadow receipt schema with exact
      repository head, authority/full-gate report identity, NUL diff digest,
      advertised file list, honored file list, closure summary, fallback state,
      and terminal status.

## 2. Shadow evaluator

- [x] Implement shadow mode behind an explicit local/operator invocation only.
- [x] Ensure shadow mode never changes CI status, merge admission, acceptance
      status, or full-gate execution.
- [x] Fail closed when selector parsing, graph construction, closure bounding,
      protected-path classification, report lookup, or receipt writing is
      incomplete.
- [x] Preserve crash-before-receipt semantics so no terminal success receipt can
      exist unless all required receipt fields were durably written together.

## 3. Acceptance checks

- [x] Add a reproducible NUL-diff check with file names containing spaces,
      newlines, and shell-sensitive characters.
- [x] Add a protected-fallback check proving protected paths force typed
      full-gate-needed shadow evidence.
- [x] Add a bounded-closure check proving node/edge overflow cannot produce a
      complete-closure receipt.
- [x] Add an exact advertise-vs-honor check proving advertised files and honored
      files match except for typed rejections.
- [x] Add a crash-before-receipt check proving a mid-evaluation crash cannot
      leave a terminal success receipt.
- [x] Add an exact head/report check proving receipts join only to the matching
      repository head and authority/full-gate report identity.

## 4. Validation

- [x] Run the focused shadow acceptance checks added in this change.
- [ ] Run the existing full gate unchanged to compare shadow evidence without
      replacing acceptance.
- [x] Run `openspec validate add-incremental-gate-shadow --strict`.
- [ ] Run `openspec validate --all --strict`.
- [ ] Run `git diff --check`.
