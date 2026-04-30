## 1. Code retirement

- [x] Move `acquireIsolatedBrowser` (and `IsolatedBrowser` / `AcquireIsolatedBrowserOptions` types) from `packages/polyfill-connectors/src/browser-daemon.ts` into a new `packages/polyfill-connectors/src/browser-launch.ts`.
- [x] Update the import in `packages/polyfill-connectors/src/connector-runtime.ts:608` to reference `./browser-launch.ts`.
- [x] Delete `packages/polyfill-connectors/src/browser-daemon.ts`.
- [x] Delete `packages/polyfill-connectors/bin/browser-daemon-worker.ts`.
- [x] Delete `packages/polyfill-connectors/src/browser-profile.ts`.
- [x] Delete `packages/polyfill-connectors/src/bootstrap.ts`.
- [x] Drop the `browser start|stop|status|restart|logs|bootstrap|probe` subcommands from `packages/polyfill-connectors/bin/pdpp-connectors.ts`. If no subcommands remain, delete the binary and its `package.json` entry.
- [x] Drop `bootstrap:browser` and `probe:browser` scripts from `packages/polyfill-connectors/package.json`.
- [x] Delete one-shot probe scripts that depended on the legacy paths: `bin/usaa-connectivity.ts`, `bin/usaa-structural-probe.ts`, `bin/amazon-listcard-probe.ts`, `bin/amazon-listpage-probe.ts`, `bin/amazon-listcard-yohtmlc-probe.ts`, `bin/amazon-capture-detail.ts`, `bin/bootstrap-slack-session.ts`, `bin/bootstrap-github-pat.ts`.

## 2. Migration

- [x] Migrate `packages/polyfill-connectors/bin/amazon-request-export.ts` from CDP-attach to `acquireIsolatedBrowser({ profileName: "amazon", headless: false })`. Preserve the existing flow, `ensureAmazonSession` integration, and INTERACTION-passing scaffold.
- [x] Migrate `packages/polyfill-connectors/bin/amazon-privacy-probe.ts` similarly.
- [x] Verify both scripts no longer read `~/.pdpp/browser-daemon.json` and no longer invoke `chromium.connectOverCDP`.

## 3. Operator-surface and docs cleanup

- [x] Remove documentation references to `pdpp-connectors browser ...` daemon/bootstrap commands from `packages/polyfill-connectors/README.md` (if present) and any `docs/local-testing-e2e.md` mentions.
- [x] Update `connectors/chatgpt/index.ts` source-file comment that references `pdpp-connectors browser bootstrap` (line 6) to point at the auto-login + INTERACTION flow.

## 3a. Patchright best-practice alignment (added during owner review)

- [x] Switch `acquireIsolatedBrowser` to `viewport: null` per the patchright README "Best Practice" config (was `{ width: 1280, height: 800 }` — a fixed viewport is a fingerprint signature antithetical to stealth). Verified by 636/636 tests passing.
- [x] Update `connector-authoring-guide.md` patchright entry to reflect the README "Best Practice": `channel: "chrome"`, `viewport: null`, `headless: false`, no custom `userAgent`/headers, do not re-add patchright-managed Chromium flags. Reference `pnpm --dir packages/polyfill-connectors exec patchright install chrome` for installation.

## 3b. Patchright channel decision — Option D (decided 2026-04-25)

See `design-notes/browser-channel-decision-memo.md` for the full decision and rationale. Owner decision summary: prefer real Chrome automatically; fall back to bundled Patchright Chromium only when Chrome is not installed; `PDPP_BROWSER_CHANNEL` is a strict override; the Docker image installs Chrome explicitly so the recommended channel is the in-container default; host install is unchanged (bundled Chromium via `postinstall`, optional `pnpm --dir packages/polyfill-connectors exec patchright install chrome` for best stealth).

- [x] `acquireIsolatedBrowser` auto-detects: prefer `channel: "chrome"` and fall back to bundled Patchright Chromium only on the patchright "Chromium distribution 'chrome' is not found" error class. Other launch errors propagate.
- [x] `PDPP_BROWSER_CHANNEL=<value>` is a strict operator override — when set, no fallback; the launcher uses the requested channel verbatim and surfaces any launch error.
- [x] Log the fallback to stderr exactly once per process so operators can see when bundled Chromium was substituted.
- [x] Dockerfile `reference` stage explicitly installs Chrome + Chromium via `pnpm --dir packages/polyfill-connectors exec patchright install --with-deps chrome chromium`, since browser assets installed during the `deps` stage do not survive into the final image.
- [x] Update `connector-authoring-guide.md`, `proposal.md`, and `design.md` to describe the auto-detect default and the strict env override (replaces any earlier "default to bundled Chromium, opt into Chrome via env" framing).
- [x] Mark `design-notes/browser-channel-decision-memo.md` `Status: decided` with the date.

## 4. OpenSpec reconciliation

- [x] In `openspec/changes/add-polyfill-connector-system/tasks.md`, append a "superseded by `retire-browser-daemon`" note to the daemon line (currently around line 91) and the related `pdpp-connectors browser` line (line 95). Do not delete the historical record.
- [x] In `openspec/changes/add-reference-runtime-spec/design.md`, drop the daemon-specific paths from the row at line 25 ("Browser-backed connectors use ... browser-daemon lifecycle commands ..."), leaving only the per-connector isolated profile path. Also drop "browser daemon commands" from the bullet at line 39.
- [x] Verify the `polyfill-runtime` capability spec under `add-polyfill-connector-system/specs/polyfill-runtime/spec.md` does not promote any daemon-specific requirement (it currently does not; this is a confirm step).

## 5. Validation

- [x] `cd /home/user/code/pdpp && openspec validate retire-browser-daemon --strict`
- [x] `cd /home/user/code/pdpp && openspec validate --all --strict`
- [x] `pnpm --filter @pdpp/polyfill-connectors typecheck`
- [x] `pnpm --filter @pdpp/polyfill-connectors test`
- [x] Manual smoke: trigger one browser-backed connector run end-to-end on the host (Amazon connector, `PDPP_AMAZON_YEARS=2026 PDPP_AMAZON_SKIP_DETAIL=1`). Confirmed it succeeded with no `~/.pdpp/browser-daemon.json` created and no daemon-log write.
- [x] Manual smoke: run `bin/amazon-request-export.ts` to its existing checkpoint; confirmed it acquires Chromium directly, reaches Privacy Central without `--submit`, and does not depend on or create a separate daemon discovery file.

## 6. Future capability (not implemented in this tranche)

- [x] _Deferred / tracked:_ change `connector-runtime.ts:609` default from `profileName = name` to `profileName = ${name}__${subjectId}` when multi-account support ships. Captured as a future requirement in the spec delta; no code change in this tranche.
