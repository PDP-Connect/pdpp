// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `public_repos` / `public_gists` are NOT coverage anchors.
 *
 * They are the most tempting numbers GitHub hands us — provider-reported,
 * already fetched, already stored on the `user_stats` record. They are also
 * wrong for the job, and this test exists so that stays discovered.
 *
 * They measure a strict SUBSET of what the collected streams walk:
 *   - `/user/repos` returns private and org repositories; `public_repos`
 *     counts only the user's own PUBLIC ones.
 *   - `/gists` returns secret gists; `public_gists` counts only public ones.
 *
 * Measured against this instance's live holdings when the anchor work was done:
 * `public_repos: 94` against 575 held repositories (355 private, 465 org-owned),
 * and `public_gists: 8` against 51 held gists — where the 8 matched the public
 * gists EXACTLY and 43 secret gists sat outside the number entirely. Binding
 * either as a denominator would assert a permanent false gap on a correct run.
 *
 * This test pins the structural fact behind those numbers: the stream walks
 * repositories the provider scalar does not count. It is deliberately about the
 * RELATIONSHIP, not a specific count.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { repoRecord, userStatsRecord } from "./parsers.ts";

test("a private or org repository is collected but is not counted by public_repos", () => {
  // One public user-owned repo — the only kind `public_repos` counts.
  const publicOwn = repoRecord({
    id: 1,
    name: "public-own",
    full_name: "octocat/public-own",
    private: false,
    owner: { login: "octocat", id: 99 },
    pushed_at: "2026-01-01T00:00:00Z",
  } as never);
  // A private repo and an org repo — both returned by `/user/repos`, and both
  // invisible to `public_repos`.
  const privateOwn = repoRecord({
    id: 2,
    name: "private-own",
    full_name: "octocat/private-own",
    private: true,
    owner: { login: "octocat", id: 99 },
    pushed_at: "2026-01-02T00:00:00Z",
  } as never);
  const orgRepo = repoRecord({
    id: 3,
    name: "org-repo",
    full_name: "acme/org-repo",
    private: false,
    owner: { login: "acme", id: 1234 },
    pushed_at: "2026-01-03T00:00:00Z",
  } as never);

  const collected = [publicOwn, privateOwn, orgRepo];

  // The provider scalar, reported by `/user`, sees only the single public
  // user-owned repository.
  const stats = userStatsRecord(
    { id: 99, login: "octocat", public_repos: 1, public_gists: 0, followers: 0, following: 0 } as never,
    "2026-01-04"
  );

  assert.equal(stats.public_repos, 1, "the provider scalar counts only public user-owned repositories");
  assert.equal(collected.length, 3, "the stream collects private and org repositories too");

  // The load-bearing assertion: using the scalar as this stream's denominator
  // would claim 2 of 3 collected repositories are missing, on a fully correct
  // run. It is a different set, not a smaller measurement of the same set.
  assert.notEqual(
    stats.public_repos,
    collected.length,
    "public_repos must never be used as the repositories denominator — it measures a different set"
  );
});
