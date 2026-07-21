## 1. Manifest fix

- [x] 1.1 Declare `"required": false` on `stars`, `user_groups`,
      `reminders`, `dm_read_states` in
      `packages/polyfill-connectors/manifests/slack.json`. No
      `coverage_policy` (see design.md decision).

## 2. Run isolation

- [x] 2.1 Add `runOptionalStream` wrapper in
      `packages/polyfill-connectors/connectors/slack/index.ts`: catches a
      thrown error from a stream-runner call, emits `SKIP_RESULT` (reason
      `optional_stream_failed`, message includes the underlying error,
      `recovery_hint.retryable` derived from `SLACK_API_RETRYABLE_FAILURE_RE`),
      and resolves rather than rejecting.
- [x] 2.2 Route the four gap streams' dispatch in `runRequestedStreams`
      through `runOptionalStream`. Required streams (workspace, channels,
      channel_memberships, users, messages/reactions/message_attachments,
      files, canvases) are unchanged — still called directly, still
      propagate a thrown error to the top-level `run().catch()`.
- [x] 2.3 Thread `emit` (the full `CollectContext["emit"]`, not the
      DETAIL_COVERAGE-narrowed `StreamDeps.emit`) through
      `runRequestedStreams` and `mergeScopedMessageArchivePasses` so
      `runOptionalStream` can emit a `SKIP_RESULT`.

## 3. Regression tests

- [x] 3.1 Extend `slackdump-runtime.test.ts`'s manifest-declaration test to
      assert `required === false` explicitly for all four gap streams (not
      merely that `coverage_policy` is absent).
- [x] 3.2 Add `runOptionalStream` unit tests in `gap-streams.test.ts`:
      failing stream → resolves + emits SKIP_RESULT; succeeding stream →
      resolves + no emit; retryable vs non-retryable error → correct
      `recovery_hint.retryable`.
- [x] 3.3 Add a contrast test proving a required stream's failure (driven
      through the real `runUsersStream`, not a stand-in) is NOT caught when
      called without the `runOptionalStream` wrapper — the isolation seam
      is opt-in per stream.
- [x] 3.4 Add the `KNOWN_MISSING_REQUIRED` ratchet test to
      `coverage-policy-manifest-honesty.test.ts`: any manifest stream that
      omits `required` and is not already on the frozen allowlist fails the
      test. Verified the test fails when `slack.json`'s fix is reverted
      (temporarily reverted, confirmed 4 failures reported, restored).
- [x] 3.5 (Revision, addressing independent review) Rebuild
      `KNOWN_MISSING_REQUIRED` as `Map<connector.stream, fingerprint>`
      instead of a bare `Set<connector.stream>`, and add
      `fingerprintSemanticStream()` (SHA-256 over every stream field except
      the cosmetic `description`/`display` prose fields). The prior
      bare-key version only caught a brand-new omission; it silently
      accepted a semantic edit (schema/`semantics`/`coverage_policy`/etc.)
      to an already-grandfathered stream as long as `required` stayed
      absent and the key stayed on the list. Verified: (a) editing
      `slack.messages`'s `semantics` field while leaving `required` absent
      now fails the test naming `slack.messages`; (b) editing
      `slack.messages`'s `description` (cosmetic) with `required` absent
      still passes; (c) a brand-new stream with no `required` still fails
      as a new omission. All three probes reverted after verification;
      `git status`/`git diff --stat` confirmed `manifests/slack.json`
      byte-identical to its pre-probe state afterward.

## 4. Verification

- [x] 4.1 `pnpm --filter polyfill-connectors typecheck` — clean.
- [x] 4.2 `pnpm --filter polyfill-connectors check` — clean on all touched
      files (one pre-existing, unrelated finding in
      `src/collector-runner.test.ts`, not touched by this change, same as
      noted in `complete-slack-bundled-connector-coverage`'s own tasks.md).
- [x] 4.3 Full package test suite: `node --test --test-timeout=30000
      --import tsx 'bin/**/*.test.ts' 'connectors/**/*.test.ts'
      'src/**/*.test.ts'` — 2438 passed, 0 failed, 6 pre-existing skips.
- [x] 4.4 `openspec validate fix-slack-optional-stream-isolation --strict`
      and `openspec validate --all --strict`.

## Non-Goals (explicitly not done here)

- Live redeploy / live acceptance verification (owner-only; task
  instructions explicitly prohibit touching live state or deploying).
- Root-causing the `stars.list` 401 itself.
- Closing the repo-wide 117-stream `required` omission gap.
