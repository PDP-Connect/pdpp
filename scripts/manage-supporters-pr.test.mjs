// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  manageSupportersPullRequest,
  publicationAction,
  retireStaleSupportersPublication,
  shellQuote,
  supportersPullRequestBody,
} from "../.github/scripts/manage-supporters-pr.mjs";

const options = {
  baseBranch: "main",
  publishBranch: "publish/supporters",
  repository: "PDP-Connect/pdpp",
};
const MAINTAINER_COMMAND = /^Maintainer command: /;
const ADMIN_RIGHTS_ERROR = /Must have admin rights to Repository/;

const pullRequestBody = supportersPullRequestBody({
  rowsAdded: 2,
  rowsRemoved: 1,
  runUrl: "https://github.com/PDP-Connect/pdpp/actions/runs/123",
  totalRows: 42,
});

function fakeGhApi(responses) {
  const calls = [];
  return {
    calls,
    run(arguments_) {
      calls.push(arguments_);
      return responses.shift() ?? { status: 0, stderr: "", stdout: "[]\n" };
    },
  };
}

test("creates a pull request when none is open", () => {
  const gh = fakeGhApi([
    { status: 0, stderr: "", stdout: "[]\n" },
    { status: 0, stderr: "", stdout: "https://github.com/PDP-Connect/pdpp/pull/320\n" },
  ]);
  const messages = [];

  const result = manageSupportersPullRequest({
    ...options,
    body: pullRequestBody,
    run: gh.run,
    write: (message) => messages.push(message),
  });

  assert.deepEqual(result, { kind: "created" });
  assert.deepEqual(gh.calls, [
    [
      "api",
      "--method",
      "GET",
      "repos/PDP-Connect/pdpp/pulls?base=main&head=PDP-Connect%3Apublish%2Fsupporters&per_page=1&state=open",
    ],
    [
      "api",
      "--method",
      "POST",
      "repos/PDP-Connect/pdpp/pulls",
      "-f",
      "title=chore(site): publish supporters register",
      "-f",
      "head=publish/supporters",
      "-f",
      "base=main",
      "-f",
      `body=${pullRequestBody}`,
    ],
  ]);
  assert.deepEqual(messages, ["Created supporters pull request."]);
  assert.equal(gh.calls[1].at(-1), `body=${pullRequestBody}`);
});

test("creates a pull request when a legacy empty lookup emits null", () => {
  const gh = fakeGhApi([
    { status: 0, stderr: "", stdout: "null\n" },
    { status: 0, stderr: "", stdout: "https://github.com/PDP-Connect/pdpp/pull/320\n" },
  ]);

  const result = manageSupportersPullRequest({
    ...options,
    body: pullRequestBody,
    run: gh.run,
    write: () => undefined,
  });

  assert.deepEqual(result, { kind: "created" });
  assert.deepEqual(gh.calls[1].slice(0, 4), ["api", "--method", "POST", "repos/PDP-Connect/pdpp/pulls"]);
});

test("updates an existing pull request", () => {
  const gh = fakeGhApi([
    { status: 0, stderr: "", stdout: '[{"number":319}]\n' },
    { status: 0, stderr: "", stdout: "" },
  ]);
  const messages = [];

  const result = manageSupportersPullRequest({
    ...options,
    body: pullRequestBody,
    run: gh.run,
    write: (message) => messages.push(message),
  });

  assert.deepEqual(result, { kind: "exists", number: "319" });
  assert.deepEqual(gh.calls, [
    [
      "api",
      "--method",
      "GET",
      "repos/PDP-Connect/pdpp/pulls?base=main&head=PDP-Connect%3Apublish%2Fsupporters&per_page=1&state=open",
    ],
    [
      "api",
      "--method",
      "PATCH",
      "repos/PDP-Connect/pdpp/pulls/319",
      "-f",
      "title=chore(site): publish supporters register",
      "-f",
      `body=${pullRequestBody}`,
    ],
  ]);
  assert.deepEqual(messages, ["Updated pull request #319."]);
  assert.equal(gh.calls[1].at(-1), `body=${pullRequestBody}`);
});

test("reports a maintainer handoff when Actions cannot create a pull request", () => {
  const gh = fakeGhApi([
    { status: 0, stderr: "", stdout: "[]\n" },
    { status: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)", stdout: "" },
  ]);
  const messages = [];

  const result = manageSupportersPullRequest({
    ...options,
    body: pullRequestBody,
    run: gh.run,
    write: (message) => messages.push(message),
  });

  assert.deepEqual(result, { kind: "forbidden" });
  assert.equal(
    messages[0],
    "NOTICE: GitHub Actions cannot open a pull request. The publisher pushed publish/supporters."
  );
  assert.deepEqual(gh.calls[1].slice(0, 4), ["api", "--method", "POST", "repos/PDP-Connect/pdpp/pulls"]);
  assert.equal(messages[1], "Compare: https://github.com/PDP-Connect/pdpp/compare/main...publish/supporters?expand=1");
  assert.equal(
    messages[2],
    `Maintainer command: 'gh' 'pr' 'create' '--repo' 'PDP-Connect/pdpp' '--base' 'main' '--head' 'publish/supporters' '--title' 'chore(site): publish supporters register' '--body' '${pullRequestBody.replaceAll("'", "'\\\\''")}'`
  );
});

test("fails a create request that has an unrelated 403", () => {
  const gh = fakeGhApi([
    { status: 0, stderr: "", stdout: "[]\n" },
    { status: 1, stderr: "gh: Must have admin rights to Repository. (HTTP 403)", stdout: "" },
  ]);

  assert.throws(
    () => manageSupportersPullRequest({ ...options, body: pullRequestBody, run: gh.run, write: () => undefined }),
    ADMIN_RIGHTS_ERROR
  );
});

test("a rebuilt register equal to main retires the stale publication after a withdrawal", () => {
  const gh = fakeGhApi([
    { status: 0, stderr: "", stdout: '[{"number":319}]\n' },
    { status: 0, stderr: "", stdout: "" },
    { status: 0, stderr: "", stdout: "" },
  ]);
  const gitCalls = [];
  const messages = [];

  assert.equal(publicationAction({ registerMatchesBase: true, registerMatchesPublishBranch: false }), "retire");
  const result = retireStaleSupportersPublication({
    ...options,
    publishBranchExists: true,
    run: gh.run,
    runGitCommand(arguments_) {
      gitCalls.push(arguments_);
      return { status: 0, stderr: "", stdout: "" };
    },
    write: (message) => messages.push(message),
  });

  assert.deepEqual(result, { branchDeleted: true, pullRequest: { kind: "closed", number: "319" } });
  assert.deepEqual(gh.calls, [
    [
      "api",
      "--method",
      "GET",
      "repos/PDP-Connect/pdpp/pulls?base=main&head=PDP-Connect%3Apublish%2Fsupporters&per_page=1&state=open",
    ],
    [
      "api",
      "--method",
      "POST",
      "repos/PDP-Connect/pdpp/issues/319/comments",
      "-f",
      "body=register now equals main; nothing to publish",
    ],
    ["api", "--method", "PATCH", "repos/PDP-Connect/pdpp/pulls/319", "-f", "state=closed"],
  ]);
  assert.deepEqual(gitCalls, [["push", "origin", "--delete", "publish/supporters"]]);
  assert.deepEqual(messages, [
    "Closed pull request #319; register now equals main.",
    "Deleted obsolete branch publish/supporters.",
  ]);
});

test("an unchanged generated branch retries a forbidden pull request creation", () => {
  const action = publicationAction({ registerMatchesBase: false, registerMatchesPublishBranch: true });
  const gh = fakeGhApi([
    { status: 0, stderr: "", stdout: "[]\n" },
    { status: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)", stdout: "" },
  ]);
  const messages = [];

  assert.equal(action, "unchanged");
  assert.deepEqual(
    manageSupportersPullRequest({
      ...options,
      body: pullRequestBody,
      run: gh.run,
      write: (message) => messages.push(message),
    }),
    { kind: "forbidden" }
  );
  assert.deepEqual(gh.calls[1].slice(0, 4), ["api", "--method", "POST", "repos/PDP-Connect/pdpp/pulls"]);
  assert.match(messages[2], MAINTAINER_COMMAND);
});

test("shell quotes an apostrophe with the POSIX single-quote escape", () => {
  assert.equal(shellQuote("supporter's register"), "'supporter'\\''s register'");
});

test("formats the standing pull request body with register rows and workflow run", () => {
  assert.equal(
    pullRequestBody,
    [
      "Automated public-register publication.",
      "",
      "Rows: +2 added, -1 removed; 42 total.",
      "Workflow run: https://github.com/PDP-Connect/pdpp/actions/runs/123",
    ].join("\n")
  );
});
