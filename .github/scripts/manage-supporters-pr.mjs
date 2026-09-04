#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

const PR_TITLE = "chore(site): publish supporters register";
const PR_BODY = "Automated public-register publication.";
const ACTIONS_PR_FORBIDDEN = /GitHub Actions is not permitted to create or approve pull requests/i;

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function prCreateArguments({ repository, baseBranch, publishBranch }) {
  return [
    "pr",
    "create",
    "--repo",
    repository,
    "--base",
    baseBranch,
    "--head",
    publishBranch,
    "--title",
    PR_TITLE,
    "--body",
    PR_BODY,
  ];
}

function runGh(arguments_) {
  const result = spawnSync("gh", arguments_, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
}

function runGit(arguments_) {
  const result = spawnSync("git", arguments_, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
}

function requireSuccess(result, arguments_, command = "gh") {
  if (result.status !== 0) {
    throw new Error(`${command} ${arguments_.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function openPullRequestNumber({ repository, baseBranch, publishBranch, run }) {
  const listArguments = [
    "pr",
    "list",
    "--repo",
    repository,
    "--head",
    publishBranch,
    "--base",
    baseBranch,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number",
  ];
  return requireSuccess(run(listArguments), listArguments);
}

function maintainerHandoff({ repository, baseBranch, publishBranch, write, notice }) {
  const compareUrl = `https://github.com/${repository}/compare/${baseBranch}...${publishBranch}?expand=1`;
  const command = ["gh", ...prCreateArguments({ repository, baseBranch, publishBranch })].map(shellQuote).join(" ");
  write(`${notice} The publisher pushed ${publishBranch}.`);
  write(`Compare: ${compareUrl}`);
  write(`Maintainer command: ${command}`);
}

/**
 * Opens or updates the generated-register pull request.
 *
 * The repository setting can forbid GITHUB_TOKEN from creating pull requests.
 * In that case the generated branch is already published, so print a
 * maintainer handoff and succeed instead of failing the scheduled publication.
 */
export function manageSupportersPullRequest({
  repository,
  baseBranch,
  publishBranch,
  openPr = true,
  run = runGh,
  write = console.log,
}) {
  const number = openPullRequestNumber({ repository, baseBranch, publishBranch, run });

  if (number) {
    const editArguments = [
      "pr",
      "edit",
      number,
      "--repo",
      repository,
      "--title",
      PR_TITLE,
      "--body",
      PR_BODY,
    ];
    requireSuccess(run(editArguments), editArguments);
    write(`Updated pull request #${number}.`);
    return { kind: "exists", number };
  }

  if (!openPr) {
    maintainerHandoff({
      repository,
      baseBranch,
      publishBranch,
      write,
      notice: "NOTICE: Pull request creation is disabled for this run.",
    });
    return { kind: "skipped" };
  }

  const createArguments = prCreateArguments({ repository, baseBranch, publishBranch });
  const created = run(createArguments);
  if (created.status === 0) {
    write("Created supporters pull request.");
    return { kind: "created" };
  }
  if (ACTIONS_PR_FORBIDDEN.test(`${created.stderr}\n${created.stdout}`)) {
    maintainerHandoff({
      repository,
      baseBranch,
      publishBranch,
      write,
      notice: "NOTICE: GitHub Actions cannot open a pull request.",
    });
    return { kind: "forbidden" };
  }
  requireSuccess(created, createArguments);
}

/** Closes the generated PR after the rebuilt register has returned to its base. */
export function closeSupportersPullRequest({
  repository,
  baseBranch,
  publishBranch,
  run = runGh,
  write = console.log,
}) {
  const number = openPullRequestNumber({ repository, baseBranch, publishBranch, run });
  if (!number) {
    write("No open supporters pull request to close.");
    return { kind: "none" };
  }

  const commentArguments = [
    "pr",
    "comment",
    number,
    "--repo",
    repository,
    "--body",
    "register now equals main; nothing to publish",
  ];
  requireSuccess(run(commentArguments), commentArguments);
  const closeArguments = ["pr", "close", number, "--repo", repository];
  requireSuccess(run(closeArguments), closeArguments);
  write(`Closed pull request #${number}; register now equals ${baseBranch}.`);
  return { kind: "closed", number };
}

/** Selects the only publication action compatible with the rebuilt register. */
export function publicationAction({ registerMatchesBase, registerMatchesPublishBranch }) {
  if (registerMatchesBase) {
    return "retire";
  }
  return registerMatchesPublishBranch ? "unchanged" : "publish";
}

/** Closes an obsolete PR and removes its generated branch, when either remains. */
export function retireStaleSupportersPublication({
  repository,
  baseBranch,
  publishBranch,
  publishBranchExists,
  run = runGh,
  runGitCommand = runGit,
  write = console.log,
}) {
  const pullRequest = closeSupportersPullRequest({ repository, baseBranch, publishBranch, run, write });
  if (!publishBranchExists) {
    return { branchDeleted: false, pullRequest };
  }
  const deleteArguments = ["push", "origin", "--delete", publishBranch];
  requireSuccess(runGitCommand(deleteArguments), deleteArguments, "git");
  write(`Deleted obsolete branch ${publishBranch}.`);
  return { branchDeleted: true, pullRequest };
}

function booleanEnvironment(name) {
  return process.env[name] === "true";
}

function main() {
  if (process.env.PUBLISH_PR_ACTION === "decide") {
    console.log(
      publicationAction({
        registerMatchesBase: booleanEnvironment("PUBLISH_REGISTER_MATCHES_BASE"),
        registerMatchesPublishBranch: booleanEnvironment("PUBLISH_REGISTER_MATCHES_BRANCH"),
      })
    );
    return;
  }
  const { GITHUB_REPOSITORY: repository, PUBLISH_BASE: baseBranch, PUBLISH_BRANCH: publishBranch } = process.env;
  if (!repository || !baseBranch || !publishBranch) {
    throw new Error("GITHUB_REPOSITORY, PUBLISH_BASE, and PUBLISH_BRANCH are required.");
  }
  if (process.env.PUBLISH_PR_ACTION === "retire") {
    retireStaleSupportersPublication({
      repository,
      baseBranch,
      publishBranch,
      publishBranchExists: booleanEnvironment("PUBLISH_BRANCH_EXISTS"),
    });
    return;
  }
  const openPr = process.env.PUBLISH_OPEN_PR !== "false";
  manageSupportersPullRequest({ repository, baseBranch, publishBranch, openPr });
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
