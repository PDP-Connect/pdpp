# Browser-channel decision memo

**Status:** decided 2026-04-25 — Option D (auto-detect with strict env override). See "Decision" section below.
**Author:** Claude (compiled from a long, somewhat tangled session)
**Raised:** 2026-04-25
**Honest meta-note:** I made several wrong inferences and reversals during the conversation that produced this memo. This document is my attempt to lay out only the things that are actually true, separate from interpretation, so the owner can decide without inheriting my back-and-forth.

---

## TL;DR

The retire-browser-daemon change is independently complete and correct. The browser-binary decision is now decided as **Option D: auto-detect with strict env override**. The launcher prefers real Chrome, falls back to bundled Patchright Chromium only when Chrome is not installed, and treats `PDPP_BROWSER_CHANNEL=<value>` as an explicit no-fallback operator override.

## Background facts

These are the underlying facts the decision rests on. None depend on interpretation.

### Patchright supports three Chromium binaries

Patchright is a patched-Playwright drop-in. Its `chromium.launchPersistentContext()` can launch one of three different Chromium binaries depending on `channel` and what's installed:

| `channel` value | Binary launched | How it gets installed | Identity vs. real Chrome |
| --- | --- | --- | --- |
| (omitted) | Patched Chromium (open-source build) | `npx patchright install chromium` (already in this repo's `postinstall` script) | Different binary. Different fingerprint. Same engine family. |
| `"chrome"` (no system Chrome) | **Chrome-for-Testing** | `npx patchright install chrome` (NOT currently run by this repo) | Real Google-built Chrome binary, no auto-update. Same identity for stealth. |
| `"chrome"` (with system Chrome installed at `/opt/google/chrome/chrome`) | System Chrome | `apt install google-chrome-stable` or equivalent | Real Google-built consumer Chrome, auto-updating. Same identity for stealth. |

When `channel: "chrome"` is set, patchright/Playwright looks for system Chrome first. If it isn't there, it falls back to Chrome-for-Testing if `patchright install chrome` was run. If neither is present, the launch fails with the error observed in `run_1777088309243`:

> `Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome. Run "npx playwright install chrome"`

### Patchright's documented "Best Practice"

Quoted verbatim from the patchright NodeJS README:

```javascript
chromium.launchPersistentContext("...", {
    channel: "chrome",
    headless: false,
    viewport: null,
    // do NOT add custom browser headers or userAgent
});
```

> "We recommend using Google Chrome instead of Chromium. You can install it via `npx patchright install chrome`"

The README does not enumerate downsides of the bundled Chromium path, but it explicitly recommends real Chrome and lists the bot-protection services patchright defeats (Cloudflare, Datadome, Kasada) under the section that contains this recommendation.

### What this repo had before the retirement

`channel: "chrome"` was hardcoded everywhere a browser was launched (daemon path, isolated path, shared profile path, all probe scripts). The dev Docker image installs neither system Chrome nor Chrome-for-Testing, so the dev image cannot launch a browser today. This was the proximate cause of `run_1777088309243`.

### What the retirement-PR code does after the owner decision

`packages/polyfill-connectors/src/browser-launch.ts` (current state on this branch):

- Reads `PDPP_BROWSER_CHANNEL` from the environment.
- If set to `"chrome"` (or any non-empty string), launches with that channel and does not fall back.
- If unset, attempts `channel: "chrome"` first → real Chrome (system or Chrome-for-Testing).
- If and only if Chrome is not installed, retries without `channel` → patchright's bundled Chromium.
- All other patchright "Best Practice" config items are honored: `viewport: null`, no custom `userAgent`, no custom headers, no re-adding of patchright-managed flags.

This is not the earlier bundled-Chromium default. It honors patchright's "use Chrome" recommendation whenever possible while keeping host checkouts functional when Chrome is absent.

### What the docs currently say

The docs now describe Option D as the supported state of the world:

- `packages/polyfill-connectors/docs/connector-authoring-guide.md` (line 58, edited after Claude's last commit)
- `openspec/changes/retire-browser-daemon/proposal.md` (line 14, edited after Claude's last commit)
- `openspec/changes/retire-browser-daemon/design.md` (softened the Docker incompatibility line)

The docs and the code are now consistent with each other — both describe Option D below.

### What the design note `host-browser-bridge-open-question.md` separately raises

Even if the Chromium binary choice is solved, a related-but-separate question remains: **how does a human owner interact with a browser the connector launches inside a container, when the connector hits a Cloudflare challenge or OTP prompt?** That note enumerates A1/A2/B/C/D options and is genuinely independent from the channel decision below; the channel decision affects whether non-interactive runs work at all in Docker, while the bridge decision affects whether interactive runs work.

This memo is **only** about the channel decision. The bridge decision is in its own note.

---

## The three options

### Option A: Real Chrome via Dockerfile install, code stays at `channel: "chrome"`

**How:** Add one line to the Dockerfile's `reference` stage:

```dockerfile
RUN cd /app/packages/polyfill-connectors && npx patchright install chrome
```

(or `--with-deps` if patchright-installed Chrome is missing system libs in this image — would need to verify.)

Revert the env-flag code in `browser-launch.ts`. Revert the doc edits that describe the env-gated default. The doc reverts to: "use `channel: chrome`; the dev image installs Chrome-for-Testing for you via patchright's own tooling."

**Pros:**
- Matches patchright's documented "Best Practice" exactly. No deviation to defend.
- Maximum stealth posture for every connector by default. Important for chase/usaa/amazon/chatgpt where Cloudflare/Datadome/Akamai detection is the dominant failure mode.
- No env flag → no operator decision to make → no "I forgot to set it" failure mode.
- Single code path. No conditional in the launcher.

**Cons:**
- Larger Docker image (Chrome-for-Testing is ~150 MB).
- One additional failure surface at image build time (`patchright install chrome` reaches Google's CDN).
- Operators who run the connectors outside Docker still need either system Chrome or to have run `patchright install chrome` themselves once. (`postinstall` only runs `patchright install chromium` today.)
- Doesn't help operators in air-gapped environments who can't reach Google's CDN at all.

### Option B: Bundled Chromium by default, real Chrome opt-in (current code state)

**How:** Keep the current `browser-launch.ts` as-is. Keep the docs as edited.

**Pros:**
- Docker works zero-config — the existing `postinstall` script (`patchright install chromium`) is sufficient.
- Operators who do have real Chrome get it via `PDPP_BROWSER_CHANNEL=chrome` opt-in.
- Smallest Docker image.
- Works in air-gapped environments out of the box (no second Google CDN call at install).

**Cons:**
- Deliberate deviation from patchright's documented "Best Practice." Every connector has slightly weaker stealth by default.
- Two code paths in the launcher (env-set vs unset).
- Operator decision required to get the recommended posture. If the docs miss it, the operator runs in a degraded posture without realizing.
- The fingerprint difference between Chromium and Chrome is real for sites like Chase that fingerprint aggressively. We have prior evidence (`design-notes/chase-anti-bot.md`) that Chase is sensitive to this kind of fingerprint variance.

### Option C: Both — install real Chrome in Docker AND keep the env flag

**How:** Add the Dockerfile install line from Option A, but keep the env-flag code from Option B. Default behavior is now: in Docker, real Chrome is available and used; on hosts, bundled Chromium is used unless the operator opts in via env.

**Pros:**
- Docker users get the patchright-recommended posture by default.
- Host users who don't want Chrome-for-Testing's ~150 MB cost don't pay it.
- Air-gapped hosts can still operate (just don't set the env flag).
- Operators with system Chrome on host can opt in to use it.

**Cons:**
- Most complex. Two install paths and one code branch.
- Most surface area to document and test.
- The defaults are actually inconsistent across deployments (Docker and host get different binaries by default), which could mask environment-specific bugs.

---

## What I (Claude) think, separated out so you can ignore it

You asked for the full context before making a recommendation, so this section is bracketed: take or leave.

**My honest read:** Option A is the cleanest answer if the ~150 MB image cost is acceptable and the Dockerfile change is allowed in this PR's scope. It eliminates the ongoing "we deviated from upstream best practice; let me explain why" footnote and matches the upstream recommendation by default. The "real Chrome via patchright's own tooling" framing is also less surprising for new contributors than the env-flag pattern.

If image-size or air-gapped-build concerns are real, Option C gets you the same default-stealth posture in Docker without forcing the host cost, at the price of two paths to maintain.

Option B is what's currently shipped. It's defensible, but it does require the doc edits we already made and a small bet that operators won't be confused by the gap between "patchright says use Chrome" and "this codebase says use bundled Chromium by default."

I'm not strongly attached to any of them. The thing I am attached to is **picking one and aligning the code, the docs, and the tasks.md so we stop maintaining a fork of the truth in three places.**

## Decision (owner, 2026-04-25): Option D — auto-detect with strict env override

The owner chose **none of A/B/C as written**. The decided behavior is:

1. **Prefer real Chrome automatically when available.** The launcher attempts `channel: "chrome"` first. If Chrome (system or Chrome-for-Testing) is present, use it.
2. **Fall back to bundled Patchright Chromium only when Chrome is not installed.** The fallback triggers exclusively on the patchright/Playwright "Chromium distribution 'chrome' is not found" class of error, NOT on arbitrary launch failures. Other launch errors (port collision, profile lock, OOM) propagate as today.
3. **`PDPP_BROWSER_CHANNEL=<value>` is a strict override.** If the operator sets it, the launcher honors it verbatim and does NOT fall back. An operator who set the env clearly intends a specific binary; silent fallback would hide real misconfiguration.
4. **The reference Docker image installs Chrome.** Chrome is installed in the final reference image (not just the deps stage — Playwright/patchright browser assets installed in earlier stages do not survive into the final image without explicit installation there). Bundled Chromium is also available via the existing `postinstall` script as fallback.
5. **Host/local dev does NOT auto-install Chrome-for-Testing.** `pnpm install` continues to install only bundled Chromium via the `postinstall` script. Hosts get "just works" via the bundled fallback. Docs recommend `pnpm --dir packages/polyfill-connectors exec patchright install chrome` for best stealth on the host.

### Rationale (owner-stated)

- Honors patchright's real-Chrome recommendation whenever possible.
- Keeps Docker functional AND aligned with the recommended stealth posture.
- Avoids turning local `pnpm install` into an intrusive Chrome install.
- Avoids hiding real launch failures: fallback only for "Chrome not installed," not arbitrary browser errors.

### Implementation plan

1. **`src/browser-launch.ts`** — replace the current "env-set vs unset" branch with auto-detect:
   - If `PDPP_BROWSER_CHANNEL` is set, use it verbatim (strict override; no fallback).
   - Otherwise, attempt `channel: "chrome"` first.
   - On a launch error matching patchright's "Chromium distribution 'chrome' is not found" pattern, retry without `channel` (bundled Chromium fallback) and log the fallback once via stderr so operators can see what happened.
   - Any other launch error: propagate as today.
2. **`Dockerfile`** — add `RUN pnpm --dir packages/polyfill-connectors exec patchright install --with-deps chrome chromium` to the `reference` stage (and any other final stage that runs browser connectors). Verify the Chrome binary survives into the final image.
3. **Docs** — `connector-authoring-guide.md` updated to describe the auto-detect default, the strict env override, the host-side `pnpm --dir packages/polyfill-connectors exec patchright install chrome` recommendation for best stealth.
4. **`proposal.md` / `design.md`** — replace the "default to bundled Chromium" framing with the auto-detect framing.
5. **`tasks.md`** — add §3b "Patchright channel decision (Option D)" with the auto-detect, Dockerfile, and doc-alignment items.
6. **Verify** — `pnpm --dir packages/polyfill-connectors run verify`, full test suite, `openspec validate --all --strict`.
7. **Commit and push** — single commit on this branch with the full retirement + Option D alignment, then push to `main` per owner instruction.
