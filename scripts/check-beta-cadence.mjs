#!/usr/bin/env node
// Release-cadence guard for the PDPP beta publish lane.
//
// semantic-release only publishes when `beta` is pushed (see
// .github/workflows/semantic-release.yml and .releaserc.yaml). Commits land on
// `main`, but a new `@pdpp/*@beta` is cut only when someone advances `beta`.
// When `beta` lags `main` for the publishable package paths, the published
// `@beta` silently goes stale — while docs/package-release-policy.md and the
// local-collector doctor both tell operators that the published `@beta` is the
// install path. Nothing else detects that lag; this guard does.
//
// What it catches: a commit that touches a publishable package path (each
// `@semantic-release/npm` pkgRoot in .releaserc.yaml, plus the release config
// and workflow themselves) is reachable from `main` but NOT from `beta`. Those
// are real, unpublished publishable changes sitting behind the beta lane.
//
// Hermetic by default: it reads only LOCAL git refs and files. It never
// contacts npm or the network, so it is safe in ordinary `node --test` runs and
// in the offline release path. When the beta/main refs are not present (e.g. a
// shallow CI checkout that fetched neither branch), it SKIPS rather than fails,
// mirroring how check-dist-tag-posture.mjs treats an unreachable registry.
// Pass `--require-refs` to turn an unresolved ref into a failure.
//
// Usage:
//   node scripts/check-beta-cadence.mjs [--require-refs] [--json]
//   pnpm release:cadence-check
//
// Waiver: set PDPP_RELEASE_CADENCE_WAIVER="<reason>" to acknowledge a known,
// intentional lag (e.g. live hosts are intentionally on repo dist to avoid
// regressing a fix that has not yet been cut to beta). The reason is printed
// and the check exits 0, but the finding is still reported so the waiver stays
// honest and visible — exactly like the dist-tag posture waiver.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = process.cwd();

// The branch the release workflow publishes from, and the branch publishable
// work lands on. Kept as plain constants (not parsed from YAML) because the
// workflow trigger and the .releaserc branch list are themselves asserted by
// release:policy-check / the workflow; this guard only needs their names.
export const PUBLISH_BRANCH = 'beta';
export const TRUNK_BRANCH = 'main';

function readFileMaybe(relativePath) {
  try {
    return readFileSync(path.join(repoRoot, relativePath), 'utf8');
  } catch {
    return '';
  }
}

// The set of repo paths whose changes only reach operators through a published
// beta. Sourced from the same `pkgRoot` entries check-package-release-policy
// reads, so the two guards cannot drift, plus the release config and workflow
// themselves (changing either changes what/how the beta lane publishes).
export function resolvePublishablePaths(releaseConfigText = readFileMaybe('.releaserc.yaml')) {
  const pkgRoots = [...releaseConfigText.matchAll(/pkgRoot:\s*"([^"]+)"/g)].map((match) => match[1]);
  return [...new Set([...pkgRoots, '.releaserc.yaml', '.github/workflows/semantic-release.yml'])].sort();
}

// Pure cadence verdict. `lagCommits` is the list of commit subjects that touch
// a publishable path and are reachable from `main` but not `beta`, or `null`
// when the refs could not be resolved (treated as skip). Pure over its inputs
// so it is unit-testable without a git repository.
//
// Returns { status, detail, count } where status is one of:
//   - 'ok'    no publishable change is stranded behind the beta lane
//   - 'lag'   one or more publishable changes are on main but not beta
//   - 'skip'  the beta/main refs were unavailable; nothing to verify
export function classifyBetaCadence({ lagCommits, publishBranch = PUBLISH_BRANCH, trunkBranch = TRUNK_BRANCH }) {
  if (lagCommits == null) {
    return {
      status: 'skip',
      count: 0,
      detail: `\`${publishBranch}\`/\`${trunkBranch}\` refs unavailable (e.g. shallow checkout); cadence not verified`,
    };
  }
  const count = lagCommits.length;
  if (count === 0) {
    return {
      status: 'ok',
      count: 0,
      detail: `no publishable change is stranded: \`${trunkBranch}\` has nothing on a publishable path that \`${publishBranch}\` lacks`,
    };
  }
  return {
    status: 'lag',
    count,
    detail:
      `${count} publishable commit(s) on \`${trunkBranch}\` have not reached the published \`${publishBranch}\` lane; ` +
      `the published \`@beta\` is stale for those paths while docs/doctor point operators at \`@beta\``,
  };
}

// Resolve a branch ref to a SHA, preferring the remote-tracking ref so CI and a
// local clone agree on what "published beta" and "trunk" mean. Returns null when
// neither the remote-tracking nor the local branch exists.
function resolveRef(runGit, branch) {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const sha = runGit(['rev-parse', '--verify', '--quiet', ref]);
    if (sha) {
      return sha.trim();
    }
  }
  return null;
}

// Collect commit subjects reachable from `trunk` but not `publish` that touch
// any publishable path. Returns null when either ref is missing (→ skip).
export function collectLagCommits(runGit, publishablePaths, publishBranch = PUBLISH_BRANCH, trunkBranch = TRUNK_BRANCH) {
  const publishSha = resolveRef(runGit, publishBranch);
  const trunkSha = resolveRef(runGit, trunkBranch);
  if (!publishSha || !trunkSha) {
    return null;
  }
  // `publish..trunk` is the set-difference (commits on trunk not reachable from
  // publish), which stays correct even when the branches have diverged rather
  // than fast-forwarded. Path-limited to publishable roots.
  const out = runGit([
    'log',
    '--no-merges',
    '--format=%h %s',
    `${publishSha}..${trunkSha}`,
    '--',
    ...publishablePaths,
  ]);
  if (out == null) {
    return null;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// Default git runner: returns trimmed stdout, or null when git exits non-zero
// (missing ref, not a repo, git absent). Never throws, so an environment
// without the refs degrades to a clean skip.
export function defaultRunGit(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const requireRefs = args.has('--require-refs');
  const asJson = args.has('--json');
  const waiver = process.env.PDPP_RELEASE_CADENCE_WAIVER?.trim();

  const publishablePaths = resolvePublishablePaths();
  const lagCommits = collectLagCommits(defaultRunGit, publishablePaths);
  const result = classifyBetaCadence({ lagCommits });

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ...result, publishablePaths, lagCommits, waiver: waiver ?? null }, null, 2)}\n`);
  } else {
    const marker = result.status === 'ok' ? 'OK  ' : result.status === 'skip' ? 'SKIP' : 'FAIL';
    process.stdout.write(`${marker} ${result.detail}\n`);
    if (result.status === 'lag') {
      for (const commit of lagCommits.slice(0, 20)) {
        process.stdout.write(`     - ${commit}\n`);
      }
      if (lagCommits.length > 20) {
        process.stdout.write(`     … and ${lagCommits.length - 20} more\n`);
      }
    }
  }

  if (result.status === 'skip') {
    if (requireRefs) {
      process.stderr.write(
        `\nFAIL --require-refs was set but the \`${PUBLISH_BRANCH}\`/\`${TRUNK_BRANCH}\` refs could not be resolved.\n`,
      );
      process.exit(1);
    }
    process.stdout.write('\nPDPP beta cadence SKIPPED: refs unavailable; nothing to verify.\n');
    process.exit(0);
  }

  if (result.status === 'ok') {
    process.stdout.write('\nPDPP beta cadence OK: no publishable change is stranded behind the beta lane.\n');
    process.exit(0);
  }

  if (waiver) {
    process.stdout.write(
      `\nPDPP beta cadence WAIVED: ${result.count} stranded publishable commit(s) acknowledged.\nReason: ${waiver}\n` +
        'Cut a current beta (owner: fast-forward/merge `main` into `beta` and push) to clear this cleanly.\n',
    );
    process.exit(0);
  }

  process.stderr.write(
    '\nPDPP beta cadence check failed: the published `beta` lane lags `main` for publishable package paths.\n' +
      'A new `@pdpp/*@beta` is cut only when `beta` is pushed, so these changes are not yet installable\n' +
      'via the `@beta` tag that docs and the local-collector doctor point operators at. Either:\n' +
      '  1. cut a current beta (owner: advance `beta` to include `main` and push), or\n' +
      '  2. set PDPP_RELEASE_CADENCE_WAIVER="<reason>" to acknowledge an intentional lag explicitly.\n' +
      'See docs/package-release-policy.md §"Beta Release Cadence".\n',
  );
  process.exit(1);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}
