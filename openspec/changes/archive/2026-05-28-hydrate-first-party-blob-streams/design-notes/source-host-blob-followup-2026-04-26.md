# Source-Host Blob Hydration — Follow-Up (GitHub gists, PR artifacts)

Status: open
Owner: owner/connectors
Created: 2026-04-26
Related: hydrate-first-party-blob-streams, polyfill-connectors:github

## Why this is its own note

GitHub `gists` and `pull_requests` straddle the records-vs-blobs
boundary: most content is text (gist file body, PR diff) and is better
modeled as records, but binary surfaces exist (binary gist files,
release assets, raw patches as octet-stream). This needs a per-stream
answer rather than a blanket "hydrate everything."

## Gists

- Current state: `github.gists.files[]` carries lightweight metadata.
  Gist file bodies are not in records and not in blobs today.
- Design question: gist file bodies are usually source code (textual).
  Promoting to `blob_ref` for ALL gist files would mean text-gist
  consumers have to follow `blob_ref.fetch_url` to get text, which is
  worse than just expanding the body inline.
- Recommended split:
  - Textual gist files → expand into the record (string field).
  - Binary gist files (detected via mime type / null-byte sniff) →
    sibling `github.gist_files` stream with `blob_ref` per binary file.
- Risk: GitHub doesn't always report a reliable mime type for gist
  files. The detection heuristic must be conservative — when in doubt,
  treat as text.

## PR artifacts

- Current state: `github.pull_requests` carries PR-level metadata only.
  Diff/patch payloads are derivable from a separate API call
  (`GET /repos/{owner}/{repo}/pulls/{n}.patch`) and are not represented.
- Design question: a "pr_artifacts" stream is plausible but the value is
  unclear vs. just calling the GitHub API directly when needed. Patches
  can be very large (release-engineering PRs); not all consumers will
  want them.
- Default: leave `pull_requests` metadata-only. Add `pr_artifacts` only
  when a concrete consumer asks. Document this decision so the gap is
  visible.

## Release assets

- Not currently in the manifest. If GitHub releases are ever modeled,
  release assets are real binary payload (compiled binaries, .tar.gz,
  installers) and should ship with `blob_ref` from the start. Note this
  for the future stream design.

## Auth and rate-limit risk

- GitHub PAT-authenticated downloads count against the same rate limit
  as the API. Hydrating large binary gists or assets at sync time can
  exhaust the limit and break metadata sync as collateral. Hydration
  must reuse the existing `p-retry` pattern and cap concurrent fetches.
- The PAT scope determines what's downloadable; private gists/repos
  fail gracefully with `hydration_status: "blocked"` (not "failed") when
  the token doesn't have permission.

## Out of scope for this follow-up

- Cloning whole repositories. Out of PDPP scope; that's a code-host tool.
- LFS-backed objects. Add only when a consumer asks.

## Exit criteria

- Decision documented on the gist-file split (textual vs binary).
- If `pr_artifacts` ships, manifest stream added with `blob_ref` and FK
  to `pull_requests.id`.
- Rate-limit reuse documented; no new fetcher code that bypasses the
  shared `p-retry` adapter.
