#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

const PR_TITLE = "chore(site): publish supporters register";
const PR_CREATION_FORBIDDEN =
  /Resource not accessible by integration \(HTTP 403\)|GitHub Actions is not permitted to create or approve pull requests/i;

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function prCreateArguments({ repository, baseBranch, publishBranch, body }) {
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
    body,
  ];
}

export function supportersPullRequestBody({ rowsAdded, rowsRemoved, totalRows, runUrl }) {
  return [
    "Automated public-register publication.",
    "",
    `Rows: +${rowsAdded} added, -${rowsRemoved} removed; ${totalRows} total.`,
    `Workflow run: ${runUrl}`,
  ].join("\n");
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
  const [owner] = repository.split("/", 1);
  const query = new URLSearchParams({
    base: baseBranch,
    head: `${owner}:${publishBranch}`,
    per_page: "1",
    state: "open",
  });
  const listArguments = ["api", "--method", "GET", `repos/${repository}/pulls?${query}`];
  const pullRequests = JSON.parse(requireSuccess(run(listArguments), listArguments));
  return String(pullRequests?.[0]?.number ?? "");
}

function maintainerHandoff({ repository, baseBranch, publishBranch, body, write, notice }) {
  const compareUrl = `https://github.com/${repository}/compare/${baseBranch}...${publishBranch}?expand=1`;
  const command = ["gh", ...prCreateArguments({ repository, baseBranch, publishBranch, body })]
    .map(shellQuote)
    .join(" ");
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
  body,
  run = runGh,
  write = console.log,
}) {
  const number = openPullRequestNumber({ repository, baseBranch, publishBranch, run });

  if (number) {
    const editArguments = [
      "api",
      "--method",
      "PATCH",
      `repos/${repository}/pulls/${number}`,
      "-f",
      `title=${PR_TITLE}`,
      "-f",
      `body=${body}`,
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
      body,
      write,
      notice: "NOTICE: Pull request creation is disabled for this run.",
    });
    return { kind: "skipped" };
  }

  const createArguments = [
    "api",
    "--method",
    "POST",
    `repos/${repository}/pulls`,
    "-f",
    `title=${PR_TITLE}`,
    "-f",
    `head=${publishBranch}`,
    "-f",
    `base=${baseBranch}`,
    "-f",
    `body=${body}`,
  ];
  const created = run(createArguments);
  if (created.status === 0) {
    write("Created supporters pull request.");
    return { kind: "created" };
  }
  if (PR_CREATION_FORBIDDEN.test(`${created.stderr}\n${created.stdout}`)) {
    maintainerHandoff({
      repository,
      baseBranch,
      publishBranch,
      body,
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
    "api",
    "--method",
    "POST",
    `repos/${repository}/issues/${number}/comments`,
    "-f",
    "body=register now equals main; nothing to publish",
  ];
  requireSuccess(run(commentArguments), commentArguments);
  const closeArguments = ["api", "--method", "PATCH", `repos/${repository}/pulls/${number}`, "-f", "state=closed"];
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
  if (!(repository && baseBranch && publishBranch)) {
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
  manageSupportersPullRequest({
    repository,
    baseBranch,
    publishBranch,
    openPr,
    body: supportersPullRequestBody({
      rowsAdded: process.env.PUBLISH_ROWS_ADDED,
      rowsRemoved: process.env.PUBLISH_ROWS_REMOVED,
      totalRows: process.env.PUBLISH_TOTAL_ROWS,
      runUrl: process.env.PUBLISH_RUN_URL,
    }),
  });
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
