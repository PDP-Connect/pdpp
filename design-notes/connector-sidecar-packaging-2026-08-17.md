# Who owns a connector's native sidecar once connectors leave the server repo?

**Status:** intake. No requirement proposed. Written from evidence produced while
shipping the Signal connector on 2026-08-17.
**Date:** 2026-08-17

## The question

Several connectors shell out to a native binary they do not own:

| connector | sidecar | license | how it ships today |
|---|---|---|---|
| slack | `slackdump` v4.4.2 | AGPL-3.0 | pinned tarball, SHA256-verified, builder stage in the RI `Dockerfile` |
| google_messages | `gmcli` | — | same arms-length-subprocess pattern |
| signal | `sigtop` v0.24.0 | ISC | built from pinned source in a Go builder stage (added today) |

All three live in the **reference implementation's** `Dockerfile`. If connectors move
into their own distribution — the data-connectors reorg — that stops working: a
connector shipped separately cannot edit the server's image build.

So: **how does an independently-distributed connector declare and obtain a native
dependency, and who verifies it works on the runtime that will actually execute it?**

## Evidence from shipping sigtop today

Seven build failures, in order. Every one was caught before shipping, but the pattern
matters more than the count:

1. `golang:1.23` too old — sigtop needs Go ≥ 1.25
2. missing `libsecret-1-dev` at build time
3. license file is `LICENSE.md`, not `LICENSE` or `COPYING`
4. **`libsecret-1.so.0` missing at runtime** — binary compiled cleanly, could not load
5. **GLIBC 2.38 vs 2.36** — `golang:latest` is Debian trixie, the runtime image is
   bookworm; the binary ran in the builder and died in the final image
6. `sigtop -v` is not a valid subcommand
7. `sigtop version` is not either

**4 and 5 are the load-bearing ones.** Both produced a binary that built successfully
and would have failed on the owner's first real sync. Neither is discoverable from the
connector's own source; both are properties of the *runtime image* the connector will
be executed in.

That is the crux. A connector author can pin a version and a checksum. A connector
author cannot know the runtime's glibc, its installed shared libraries, or its
architecture — and today's evidence says those are exactly what break.

## What the current pattern gets right

Worth preserving whatever the packaging answer is:

- **Pinned version + SHA256** on the downloaded artifact (`slackdump`), or a pinned
  source tag with a commit-exact `SOURCE_URL` recorded (`sigtop`).
- **Isolated builder stage** — Go and build dependencies never reach the final image.
- **License and corresponding-source URL copied into the image**, which AGPL §6(d)
  requires for `slackdump` and is good practice for ISC.
- **Build-time smoke test.** `slackdump version` and (now) an execute-and-check for
  `sigtop`. This is what caught failures 4 and 5. A verification step written as
  `... || true` would have shipped both.

## Options, none yet chosen

**A. Connector declares, runtime resolves.** The manifest names a sidecar (source, pinned
version, checksum, license) and the runtime image build reads those declarations and
produces the binaries. Keeps one place that knows the runtime's glibc and libraries.
Cost: the runtime build must enumerate every connector, which partially re-couples what
the reorg is trying to separate.

**B. Connector ships prebuilt per platform.** Each connector distributes its own
binaries for supported platform triples; the runtime verifies checksum and executability
on load. Fully decoupled. Cost: connector authors take on cross-compilation and a
platform matrix, and today's evidence says that is precisely where the failures live.

**C. Sidecar declared as a runtime prerequisite.** The connector declares "requires
`sigtop` ≥ 0.24 on PATH" and refuses to register when absent, with a clear message. Zero
packaging burden, but it breaks the property that makes the current product good — a
self-hoster following the docker/railway/fly.io steps gets working connectors with no
extra install. Slack works today because `slackdump` is *in the image*.

## The constraint any answer must satisfy

**Whatever ships must be verified against the runtime it will execute on, at build time,
by executing it.** Not "the artifact downloaded," not "the checksum matched" — those both
passed today while the binary was unrunnable. The only check that caught it was running
the thing.

## Open questions

- Does the reorg keep a single runtime image, or do connectors get their own containers?
  Option B is much more attractive in the latter case.
- Is there an existing prior-art answer here? Language package managers with native
  extensions solve a similar problem (Python wheels' manylinux, Node prebuilds), and
  manylinux exists specifically because of the glibc problem hit today. Worth a sweep
  before designing.
- How does a self-hoster on a non-Debian base fare today? Untested — the current
  `slackdump`/`sigtop` stages both assume Debian.

## Related

Same shape as the collector/server contract gap
(`upstream-disclosure-window-2026-08-17.md` and the collector-contract findings): a
component whose correctness depends on a peer's version, with nothing verifying the pair
is compatible. Here the failure is loud at build time if a smoke test exists, and silent
until first use if it does not.

---

## Proposed requirement (appended 2026-08-17 after prior-art research)

Research: `~/.tmp/reorg-0814/sidecar-abi-prior-art.md` (corpus entry filed). Key finding:
manylinux, Node prebuilds, and N-API all declare compatibility as data and verify by static
analysis or eliminate the variable by construction — **no surveyed ecosystem executes the
artifact on the real target before accepting it**. The constraint this note demanded is a
genuine gap in prior art; adopting it puts this registry ahead of, not behind, the state of
the practice.

Direction (option B, shaped by the registry design; proposed, not owner-ratified):

1. **Static by default** — `CGO_ENABLED=0`/musl-static for any sidecar without a real
   `dlopen` dependency; erases the glibc class by construction (verify per-tool, don't assume).
2. **ABI tags where dynamic is unavoidable** — per-artifact `{os, arch, libc, libc_floor,
   linkage}` (manylinux/prebuildify model), built inside a pinned deliberately-old shared
   build image (the registry's manylinux-image equivalent), so the floor is infrastructure,
   not per-author judgment.
3. **`smoke_cmd` becomes a manifest/artifact field** — the trusted installer executes it on
   the actual runtime at install time and refuses on failure; loader errors already
   distinguish "missing library" from "symbol too new" with no parsing.
4. **Graceful fallback** — on smoke failure, try the static/alternate build before failing
   the connector.

Why not options A/C: A cannot survive in-app connector install (no image rebuild available
at user install time) — transitional-only by construction; C breaks the self-hoster
works-out-of-the-box property this note already names.

Transitional: today's Dockerfile builder stages are server-repo property, untouched by the
connector-content move; recorded as a known coupling whose removal trigger is registry
artifacts carrying ABI-tagged (or per-connector-container) sidecars. For server deployments
the container sandbox tier ultimately makes the sidecar ABI self-contained inside the
connector's own image; the tag machinery chiefly serves bare-metal desktop.

---

## The packaging rule (settled 2026-08-17, window 20 disposition)

**Sidecar packaging keys off the connector's placement bindings, not one uniform
mechanism.**

- **Network-authenticated sidecars** (`slackdump`) belong in the server's runtime image.
  The tool reaches the provider over the network, so the server is a legitimate place to
  run it, and the builder-stage pattern above is the right answer.
- **Session-bound sidecars** (`sigtop`) can only be acquired to the *user's* machine.
  No server-side image stage can help, because the constraint is not where the file is —
  it is where the key can be unwrapped.

That sentence is what makes the rest of this note cohere, and it is why "put the binary in
the image" was the wrong instinct for Signal.

### Evidence: Signal cannot run server-side, by construction

Tested against real data on this host, four successive configurations:

| attempt | result |
|---|---|
| container, no mounts | `open /root/.config/Signal/sql/db.sqlite: no such file` |
| + Signal data mounted read-only | `cannot decrypt database key: cannot connect to D-Bus session bus` |
| + host `/run/user/1000/bus` mounted | `EOF` (uid mismatch) |
| + `--user 1000:1000` | `An AppArmor policy prevents this sender from sending this message` |

`~/.config/Signal/config.json` holds `encryptedKey` with `safeStorageBackend: kwallet6`
and no plaintext key. Mounting the database is insufficient because **the key is not in
the file** — it unwraps only through a session-bound keyring daemon.

### Consequences adopted

1. **Signal ships local-collector-only**, with a PATH/`SIGTOP_BIN` resolution and a clear
   install error as the interim acquisition story. Connector code must not fetch
   executables at runtime; a downloader in the npm package today would be the insecure
   version of the signed, ABI-tagged registry artifacts already designed above.
2. **The constraint is now declared, not discovered.** `desktop_session` is a
   first-class binding in `runtime_requirements.bindings`, and
   `sourceKindFromManifestBindings` resolves it to `local_device` — the same placement
   mechanism that already keeps browser connectors off the collector profile. The engine
   refuses server-side placement up front rather than failing four D-Bus layers deep.
3. **The `sigtop` builder stage is removed from the Core image.** Shipping a binary that
   cannot work there implies support that does not exist. The builder-stage pattern
   remains proven via `slackdump`.

### Edge case worth documenting, not shipping for

Signal Desktop configured with `safeStorageBackend: basic_text` stores the key
**unwrapped**, so a server-side path does exist for users who have disabled their keyring.
That is a documentation note, not a reason to carry an image stage — and a connector that
declares `desktop_session` should keep declaring it, since the common configuration is the
session-bound one.

### Carry-through

The connector fleet was copied to `data-connectors` around this change. The manifest and
engine edits above were made in pdpp's canonical copy and **must be carried through the
cutover rather than silently diverging.**
