## Why the daemon was incidental, not load-bearing

The daemon's pitch was: long-lived Chromium preserves `Session`-scoped cookies (no `Max-Age`) across connector runs, so banking sites with short server-side sessions don't force a re-auth on every run.

In practice, the runtime model already serializes runs per connector and schedules them on hour-or-day intervals — well outside the window where in-memory session-cookie persistence buys anything. Server-side session timeouts (USAA ≈15 min idle) hit first regardless of whether the browser process stayed alive. The connector's `ensureSession`/auto-login path handles re-auth, which is the robust answer for any non-trivial gap between runs.

For platforms with long-lived persistent cookies (Amazon, GitHub, Spotify, Slack), the cookie data lives on disk in the profile directory — surviving Chromium restart trivially. Daemon adds nothing there.

The two real costs of removing the daemon:

| Cost | Mitigation |
| --- | --- |
| Re-auth on every run for short-server-session sites (USAA-class) | Existing `ensureSession` path; cost is one extra round-trip per run, not correctness |
| Cold-start latency (~1–2s extra Chromium launch per run) | Negligible relative to typical run time (seconds to minutes) |

The two real benefits of removing the daemon:

| Benefit | Why it matters |
| --- | --- |
| Full patchright stealth stack (launch-side + client-side) instead of CDP-attach (launch-side only) | Patchright's own README states client-side stealth requires importing patchright in the connector; CDP-attach forfeits that. Browser connectors most need stealth. |
| Per-connector profile isolation | Amazon's fingerprint can't leak into Chase's session. Aligns with eventual multi-account support (per-subject profile keys). |

## Why the shared-profile path goes too

`src/browser-profile.ts` and `src/bootstrap.ts` are not the daemon, but they share the same operational surface assumptions: one shared `~/.pdpp/browser-profile/` directory, plain-Playwright `channel: "chrome"`, and a `pdpp-connectors browser bootstrap` UX that opens nine tabs at once for a human to log in to everything.

That model is already known-suboptimal (`add-polyfill-connector-system/design-notes/unattended-operation.md:49` — "requires laptop access. Wrong for unattended. The connector should drive login itself"). It also exhibits the same `channel: "chrome"` Docker incompatibility as the daemon path when system Chrome is not installed.

The isolated launcher now resolves that binary question explicitly: if `PDPP_BROWSER_CHANNEL` is set, it is a strict operator override; otherwise, the launcher attempts the real-Chrome channel first and falls back to bundled Patchright Chromium only for the "Chrome is not installed" error class. The reference Docker image installs Chrome in the final runtime stage so containerized runs use the recommended channel by default. Human access to a browser launched inside Docker is separate and remains tracked in `add-polyfill-connector-system/design-notes/host-browser-bridge-open-question.md`.

Connector auto-login already handles initial credentialing through normal `INTERACTION kind=credentials` from a regular connector run. The bootstrap UX duplicates that capability in a less-honest way (it leaks platform-list discovery into a CLI, isn't tied to a run, doesn't go through the operator surface).

Deleting it removes the duplication without losing any production capability. The `bin/bootstrap-*.ts` and `bin/usaa-*.ts` / `bin/amazon-list*-probe.ts` scripts were one-shot reverse-engineering aids; their findings live in connector code and design notes.

## Migration paths

### `acquireIsolatedBrowser`
Move from `src/browser-daemon.ts` (lines 247–330) to a new `src/browser-launch.ts`. The current filename actively misleads — the function explicitly comments "This does NOT go through the daemon." Behavior unchanged.

### `connector-runtime.ts:608`
```ts
- const { acquireIsolatedBrowser } = await import("./browser-daemon.ts");
+ const { acquireIsolatedBrowser } = await import("./browser-launch.ts");
```

### `bin/amazon-request-export.ts` and `bin/amazon-privacy-probe.ts`
Replace the daemon-discovery + `chromium.connectOverCDP(disc.wsEndpoint)` block with:

```ts
import { acquireIsolatedBrowser } from "../src/browser-launch.ts";

const { context, release } = await acquireIsolatedBrowser({
  profileName: "amazon",
  headless: false,
});
try {
  const page = await context.newPage();
  // ... existing flow ...
} finally {
  await release();
}
```

Same `~/.pdpp/profiles/amazon/` profile dir the runtime Amazon connector uses; same patchright stealth; no daemon.

### `bin/pdpp-connectors.ts`
Drop the `browser start|stop|status|restart|logs|bootstrap|probe` subcommands. The CLI surface left after removal is whatever was there before browser commands existed; if nothing remains, delete the binary entry from `package.json`.

## Multi-account future-capability note

The current `acquireIsolatedBrowser` profile-name default at `connector-runtime.ts:609` is:

```ts
const profileName = browser.profileName ?? name;
```

This makes profiles per-connector, not per-(connector, account). Two accounts on the same platform would collide on `~/.pdpp/profiles/<name>/SingletonLock`.

When multi-account ships, the convention SHALL become:

```ts
const profileName = browser.profileName ?? `${name}__${subjectId}`;
```

Per-subject profile dirs naturally support concurrent runs across accounts on the same platform. Cookies, "trusted device" state, and fingerprints stay isolated per-account, which is also the only correct security posture (sharing across accounts would risk cross-account data leakage).

This is documented as a future requirement in the polyfill-runtime spec delta. No code change in this tranche.

## Patchright channel selection (decided 2026-04-25, "Option D")

Per `design-notes/browser-channel-decision-memo.md`:

- `acquireIsolatedBrowser` auto-detects the binary. If `PDPP_BROWSER_CHANNEL` is set, it is honored verbatim with no fallback (operator opt-in, including `chrome` to force real Chrome or any other patchright-supported channel). If unset, the launcher tries `channel: "chrome"` first, and on the specific patchright/Playwright "Chromium distribution 'chrome' is not found" error it falls back once to bundled Patchright Chromium (installed by package `postinstall`) and logs the fallback to stderr. Other launch errors propagate.
- The reference Docker image installs both Chrome (`patchright install chrome --with-deps`) and Chromium in the final `reference` stage, because browser assets installed during the `deps` stage do not survive into the final image. Inside that image, the recommended `channel: "chrome"` is the default with no operator action needed.
- Host/local development is not modified to auto-install Chrome-for-Testing during `pnpm install`. Local hosts get "just works" via the bundled Chromium fallback. Operators who want best-stealth on the host run `pnpm --dir packages/polyfill-connectors exec patchright install chrome` once, after which auto-detect picks it up automatically.

## What this does *not* solve

This change is about removing dead operational surface and aligning the codebase with the production runtime path. It does NOT:

- Add a per-connector replacement for the `bootstrap browser` UX (deferred; auto-login + `INTERACTION kind=credentials` is the supported flow).
- Add long-running / GDPR-export workflow primitives (the GDPR "request my data" capability is a future capability; the daemon was never the right primitive for it — see proposal §"Out of scope").
- Add a noVNC / X11 / host-browser CDP bridge for in-Docker headed connector operation (separate operational concern; tracked in `add-polyfill-connector-system/design-notes/host-browser-bridge-open-question.md`).

## Acceptance Checks

- `openspec validate retire-browser-daemon --strict`
- `openspec validate --all --strict`
- `pnpm --filter @pdpp/polyfill-connectors typecheck` (or local equivalent) passes after migration
- `pnpm --filter @pdpp/polyfill-connectors test` passes after migration
- A manual run of `pdpp run timeline <run-id>` for any browser-backed connector succeeds end-to-end against the host (container-host browser interaction tracked separately)
- `bin/amazon-request-export.ts` runs to its existing checkpoint without daemon discovery file
- `~/.pdpp/browser-daemon.json`, `~/.pdpp/browser-daemon.log`, and `~/.pdpp/browser-profile/` are no longer created or read
